import { test, expect } from 'vitest';
import { endCallTool } from '../server/agent/tools/end-call.ts';
import type { ObsEvent } from '../shared/events.ts';
import { createVoiceTimeline } from '../server/obs/voice-timeline.ts';
import {
  buildVoiceTwimlOptions,
  handleVoiceDisconnect,
  handleVoicePrompt,
  VOICE_FALLBACK_TEXT,
  type VoiceSender,
} from '../server/twilio/voice.ts';
import { handoffTool } from '../server/twilio/handoff.ts';
import { findHandoffSnapshot, forgetHandoffSnapshot } from '../server/handoff/snapshots.ts';
import { VOICE_ACTION_PATH } from '../shared/handoff.ts';
import { fakeTac, tacCalls, voiceSession } from './helpers/fake-tac.ts';
import {
  fakeTurnDeps,
  recordingSender,
  silentLogger,
  voiceDeps,
  voiceRegistry,
} from './helpers/fake-voice.ts';

/**
 * The three voice exit paths, which are the three places voice differs from SMS — and every one of
 * them fails as SILENCE on a real call, so none of them is observable without driving the handler.
 *
 * The `{ signal }` test is the one that earns its place. Passing our own AbortSignal to
 * `sendStreamingResponse` looks redundant next to TAC's own per-conversation controller, and a future
 * reader would be right to think it defensive — it is not. TAC resolves
 * `options?.signal ?? activeTask?.controller.signal`, and its `cancelStreamTask` aborts the
 * controller AND THEN DELETES the map entry, so on a barge-in the fallback is `undefined`,
 * `signal?.aborted` is falsy forever, and the caller gets talked over with the answer they just
 * interrupted. Deleting the option is therefore invisible in typecheck, in review, and on any call
 * where nobody interrupts. This test is what makes it visible.
 */

/** Drive the end_call tool the way the model would, for the current conversation. */
const requestEndCall = async (conversationId: string, reason = 'caller said goodbye'): Promise<void> => {
  await endCallTool.execute(
    { reason },
    // `profileId: null` deliberately: `end_call` is the one shipped tool that must work for an
    // unrecognised caller, because hanging up cannot depend on Orchestrator having resolved a customer.
    { conversationId, logger: silentLogger, profileId: null },
  );
};

/**
 * Run TAC's real handoff tool the way the model would, and hand back the LIVE session it parked the
 * frame on — the same object the prompt handler is then given, because that is how TAC dispatches:
 * `getConversationSession` returns the session by reference, not a copy, so the field the tool wrote
 * is already visible on the prompt payload and the drain needs no second lookup.
 *
 * `voiceSession` from `./helpers/fake-tac.ts` rather than a local literal, and its `calls` argument is
 * what makes the park land in the same ordered array as the two Conversation Orchestrator round-trips.
 */
const requestHandoff = async (
  conversationId: string,
  reason = 'caller asked for a person',
): Promise<{ session: ReturnType<typeof voiceSession>; calls: string[] }> => {
  const tac = fakeTac();
  const calls = tacCalls(tac);
  const session = voiceSession(conversationId, calls);
  await handoffTool({ tac, sessions: { getConversationSession: () => session } }).execute(
    { reason },
    { conversationId, logger: silentLogger, profileId: 'profile_voice' },
  );
  return { session, calls };
};

/**
 * The parked frame, read BEFORE the drain runs.
 *
 * Not optional pedantry: the helper implements `pendingHandoffData` as an accessor so the park is
 * recorded, and a correct drain `delete`s that property — which removes the accessor along with the
 * value. After the drain there is nothing left to compare the sent bytes against.
 */
const parkedFrame = (session: object): string =>
  JSON.stringify((session as { pendingHandoffData?: unknown }).pendingHandoffData);

const stillParked = (session: object): unknown =>
  (session as { pendingHandoffData?: unknown }).pendingHandoffData;

test('a normal turn streams to the caller and speaks no fallback', async () => {
  const events: ObsEvent[] = [];
  const turn = fakeTurnDeps(['Order ', 'A4721 ', 'has shipped.'], 'Order A4721 has shipped.', events);
  const rec = recordingSender();

  await handleVoicePrompt(
    {
      conversationId: 'conv_voice_1',
      transcript: 'where is order A4721',
      abortSignal: new AbortController().signal,
      memory: undefined,
    },
    voiceDeps(turn, rec.sender),
  );

  expect(rec.streamed.join('')).toBe('Order A4721 has shipped.');
  // The talk cycle was closed by the streamed `last: true`, so nothing extra may be said — a
  // second send here is the "spurious empty turn" TAC's own source warns about.
  expect(rec.spoken).toEqual([]);
  expect(events.map((e) => e.kind)).toContain('voice.transcript');
  expect(events.filter((e) => e.kind === 'error')).toEqual([]);
});

test('the caller-supplied abort signal is handed to sendStreamingResponse', async () => {
  const events: ObsEvent[] = [];
  const turn = fakeTurnDeps(['hello'], 'hello', events);
  const rec = recordingSender();
  const abort = new AbortController();

  await handleVoicePrompt(
    {
      conversationId: 'conv_voice_2',
      transcript: 'hi',
      abortSignal: abort.signal,
      memory: undefined,
    },
    voiceDeps(turn, rec.sender),
  );

  // Not `toBeDefined()`: it must be OUR signal. TAC's own fallback is deleted on a barge-in, so
  // anything else here means interruption silently stops working.
  expect(rec.signals).toEqual([abort.signal]);
});

test('a barge-in speaks nothing and reports no error', async () => {
  const events: ObsEvent[] = [];
  const turn = fakeTurnDeps(['I can help with', ' that order'], 'I can help with that order', events);
  const rec = recordingSender();
  const abort = new AbortController();
  // Aborted before the turn starts, which is what a barge-in looks like from in here once TAC has
  // cancelled the stream task.
  abort.abort();

  await handleVoicePrompt(
    {
      conversationId: 'conv_voice_3',
      transcript: 'actually never mind',
      abortSignal: abort.signal,
      memory: undefined,
    },
    voiceDeps(turn, rec.sender),
  );

  // The two assertions that matter, and both are the OPPOSITE of `messaging.ts`'s abort branch:
  // an interrupted caller must not be spoken to, and an interruption is not an error.
  expect(rec.spoken).toEqual([]);
  expect(events.filter((e) => e.kind === 'error')).toEqual([]);
});

test('an empty answer speaks the fallback, or the talk cycle never closes', async () => {
  const events: ObsEvent[] = [];
  // Zero deltas: `sendStreamingResponse` sends no `{last: true}` marker at all in this case, so
  // ConversationRelay would wait on us forever and the caller would hear an open line.
  const turn = fakeTurnDeps([], '', events);
  const rec = recordingSender();

  await handleVoicePrompt(
    {
      conversationId: 'conv_voice_4',
      transcript: 'hello?',
      abortSignal: new AbortController().signal,
      memory: undefined,
    },
    voiceDeps(turn, rec.sender),
  );

  expect(rec.streamed).toEqual([]);
  expect(rec.spoken).toEqual([VOICE_FALLBACK_TEXT]);
  expect(events.some((e) => e.kind === 'error')).toBe(true);
});

test('a send failure still speaks the fallback rather than throwing at TAC', async () => {
  const events: ObsEvent[] = [];
  const turn = fakeTurnDeps(['hi'], 'hi', events);
  const spoken: string[] = [];
  const sender: VoiceSender = {
    sendStreamingResponse: async () => {
      throw new Error('No active WebSocket connection for conversation conv_voice_5');
    },
    sendResponse: async (_id, message) => {
      spoken.push(message);
    },
    getWebsocket: () => null,
  };

  // Must not reject: TAC swallows what escapes a prompt handler and only logs it, so a throw from
  // here is silence on a live call.
  await expect(
    handleVoicePrompt(
      {
        conversationId: 'conv_voice_5',
        transcript: 'hi',
        abortSignal: new AbortController().signal,
        memory: undefined,
      },
      voiceDeps(turn, sender),
    ),
  ).resolves.toBeUndefined();

  expect(spoken).toEqual([VOICE_FALLBACK_TEXT]);
  expect(events.some((e) => e.kind === 'error')).toBe(true);
});

test('a disconnect ends the trace root and clears the transcript', async () => {
  const events: ObsEvent[] = [];
  const turn = fakeTurnDeps(['hi'], 'hi', events);
  const conversations = voiceRegistry();
  turn.history.append('conv_voice_6', [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
  ]);
  conversations.traceparentFor('conv_voice_6');
  expect(conversations.size()).toBe(1);

  handleVoiceDisconnect({ conversationId: 'conv_voice_6' }, { turn, conversations, timeline: createVoiceTimeline() });

  expect(conversations.size()).toBe(0);
  // A privacy boundary, not just tidiness: Orchestrator reuses a conversation id per profile, so a
  // transcript left behind could surface in that person's next call.
  expect(turn.history.read('conv_voice_6')).toEqual([]);
  expect(events.map((e) => e.kind)).toContain('voice.disconnect');
});

test('end_call sends the end frame AFTER the farewell, not before', async () => {
  const events: ObsEvent[] = [];
  const turn = fakeTurnDeps(['Thanks for ', 'calling. Goodbye!'], 'Thanks for calling. Goodbye!', events);
  const rec = recordingSender();
  await requestEndCall('conv_voice_7');

  await handleVoicePrompt(
    {
      conversationId: 'conv_voice_7',
      transcript: "that's everything, thanks",
      abortSignal: new AbortController().signal,
      memory: undefined,
    },
    voiceDeps(turn, rec.sender),
  );

  // THE ORDER IS THE ASSERTION. Every token of the farewell, and only then the documented
  // end-session frame — `handoffData` is optional per Twilio and we send none. Sending the frame any
  // earlier is the truncated-goodbye bug, and it would satisfy a test that only checked both
  // happened.
  expect(rec.order).toEqual([
    'token:Thanks for ',
    'token:calling. Goodbye!',
    'frame:{"type":"end"}',
  ]);
  const ended = events.find((e) => e.kind === 'voice.end');
  expect(ended?.payload).toMatchObject({ frameSent: true, reason: 'caller said goodbye' });
});

test('a turn with no end_call sends no frame', async () => {
  const events: ObsEvent[] = [];
  const turn = fakeTurnDeps(['Sure, one moment.'], 'Sure, one moment.', events);
  const rec = recordingSender();

  await handleVoicePrompt(
    {
      conversationId: 'conv_voice_8',
      transcript: 'can you check my order',
      abortSignal: new AbortController().signal,
      memory: undefined,
    },
    voiceDeps(turn, rec.sender),
  );

  expect(rec.frames).toEqual([]);
  expect(events.some((e) => e.kind === 'voice.end')).toBe(false);
});

test('interrupting the goodbye cancels the hangup', async () => {
  const events: ObsEvent[] = [];
  const turn = fakeTurnDeps(['Goodbye!'], 'Goodbye!', events);
  const rec = recordingSender();
  const abort = new AbortController();
  await requestEndCall('conv_voice_9');
  abort.abort();

  await handleVoicePrompt(
    {
      conversationId: 'conv_voice_9',
      transcript: 'actually hold on',
      abortSignal: abort.signal,
      memory: undefined,
    },
    voiceDeps(turn, rec.sender),
  );

  // Talking over the goodbye is how a caller says "wait, one more thing". Hanging up on them there
  // would be the worst possible reading of an interruption.
  expect(rec.frames).toEqual([]);

  // And the intent must be GONE, not merely skipped — otherwise the next turn inherits a hangup the
  // caller already cancelled, and they get cut off mid-conversation.
  const rec2 = recordingSender();
  await handleVoicePrompt(
    {
      conversationId: 'conv_voice_9',
      transcript: 'one more thing',
      abortSignal: new AbortController().signal,
      memory: undefined,
    },
    voiceDeps(fakeTurnDeps(['Of course.'], 'Of course.', events), rec2.sender),
  );
  expect(rec2.frames).toEqual([]);
});

test('a hangup on a socket that has already gone reports frameSent false', async () => {
  const events: ObsEvent[] = [];
  const turn = fakeTurnDeps(['Bye.'], 'Bye.', events);
  const rec = recordingSender({ socketOpen: false });
  await requestEndCall('conv_voice_10', 'caller rang off');

  await handleVoicePrompt(
    {
      conversationId: 'conv_voice_10',
      transcript: 'bye',
      abortSignal: new AbortController().signal,
      memory: undefined,
    },
    voiceDeps(turn, rec.sender),
  );

  // Must not throw — the caller hanging up first is routine, not an error.
  expect(events.find((e) => e.kind === 'voice.end')?.payload).toMatchObject({ frameSent: false });
});

test("the handoff frame goes out AFTER the farewell, and is TAC's frame verbatim", async () => {
  const events: ObsEvent[] = [];
  const turn = fakeTurnDeps(
    ['Of course — ', 'putting you through now.'],
    'Of course — putting you through now.',
    events,
  );
  const rec = recordingSender();
  const { session, calls } = await requestHandoff('conv_handoff_1');

  // Read before the drain, and asserted before it too: the tool did its two Orchestrator round-trips
  // and THEN parked. That ordering is `tests/handoff.test.ts`'s business, but the third entry is what
  // proves this test is exercising a genuinely parked frame rather than an empty field.
  expect(calls).toEqual([
    'update:conv_handoff_1:INACTIVE',
    'clear:conv_handoff_1',
    'park:conv_handoff_1',
  ]);
  const parked = parkedFrame(session);

  await handleVoicePrompt(
    {
      conversationId: 'conv_handoff_1',
      transcript: 'can I talk to a human please',
      abortSignal: new AbortController().signal,
      memory: undefined,
      session,
    },
    voiceDeps(turn, rec.sender),
  );

  // THE ORDER IS THE ASSERTION, the same shape as the end_call test above. Every token of the
  // farewell, and only then the frame. A drain that fired before the stream would leave the frame at
  // index 0 and fail here — which is the truncated-goodbye bug, and the one failure mode no typecheck
  // and no review can see. `toEqual` on the whole array also pins that exactly ONE frame went out:
  // two `{"type":"end"}` messages on one socket is undefined behaviour.
  expect(rec.order).toEqual([
    'token:Of course — ',
    'token:putting you through now.',
    `frame:${parked}`,
  ]);

  // And the bytes are TAC'S, not a frame we rebuilt. The double encoding is REQUIRED — Twilio
  // documents `handoffData` as a JSON-encoded string, so this is a string inside a string.
  const frame = JSON.parse(parked);
  expect(frame.type).toBe('end');
  expect(typeof frame.handoffData).toBe('string');
  expect(JSON.parse(frame.handoffData)).toMatchObject({ conversationId: 'conv_handoff_1' });

  // Drained from the session, so a later turn on a reused conversation id cannot send it again. This
  // is unforgeable: the value was readable two assertions ago, so `undefined` here can only mean the
  // drain deleted it.
  expect(stillParked(session)).toBeUndefined();

  const published = events.find((e) => e.kind === 'handoff');
  expect(published?.payload).toMatchObject({
    reason: 'caller asked for a person',
    frameSent: true,
    hadPayload: true,
  });

  forgetHandoffSnapshot('conv_handoff_1');
});

test('the snapshot holds the CURRENT turn — the request and the farewell', async () => {
  const events: ObsEvent[] = [];
  const turn = fakeTurnDeps(['Putting you through.'], 'Putting you through.', events);
  const rec = recordingSender();
  const { session } = await requestHandoff('conv_handoff_2', 'upset caller');

  await handleVoicePrompt(
    {
      conversationId: 'conv_handoff_2',
      transcript: 'I need a person, now',
      abortSignal: new AbortController().signal,
      memory: undefined,
      session,
    },
    voiceDeps(turn, rec.sender),
  );

  // `run-turn.ts:621` appends the user+assistant pair BEFORE `done` resolves, so snapshotting at the
  // drain — not inside the tool — is what captures the line that caused the transfer. Inside the tool
  // history would hold neither turn, and `handleVoiceDisconnect` clears it moments later.
  const { snapshot, match } = findHandoffSnapshot({ conversationId: 'conv_handoff_2' });
  expect(match).toBe('exact');
  expect(snapshot?.reason).toBe('upset caller');
  // From `session.authorInfo.address`, which is the only correlator the Studio path leaves us.
  expect(snapshot?.from).toBe('+15554443333');
  expect(snapshot?.transcript).toEqual([
    { role: 'user', text: 'I need a person, now' },
    { role: 'assistant', text: 'Putting you through.' },
  ]);

  forgetHandoffSnapshot('conv_handoff_2');
});

test('a handoff BEATS a pending end_call, and only one frame is sent', async () => {
  const events: ObsEvent[] = [];
  const turn = fakeTurnDeps(['One moment.'], 'One moment.', events);
  const rec = recordingSender();
  // Both intents pending at once, which a model can produce in one turn. Two `{"type":"end"}` frames
  // on one socket is undefined behaviour, and hanging up on someone who has just asked for a human is
  // the worst available outcome — so the hangup must be DROPPED, not queued behind the transfer.
  await requestEndCall('conv_handoff_3');
  const { session } = await requestHandoff('conv_handoff_3');
  const parked = parkedFrame(session);

  await handleVoicePrompt(
    {
      conversationId: 'conv_handoff_3',
      transcript: 'get me a human',
      abortSignal: new AbortController().signal,
      memory: undefined,
      session,
    },
    voiceDeps(turn, rec.sender),
  );

  // One frame, and it is the handoff one — a bare `{"type":"end"}` here would mean the hangup won.
  expect(rec.frames).toEqual([parked]);
  expect(events.some((e) => e.kind === 'handoff')).toBe(true);
  expect(events.some((e) => e.kind === 'voice.end')).toBe(false);

  // CONSUMED, not merely skipped. A second turn on the same id must not inherit the hangup, which is
  // what would happen if the drain returned early without clearing the end_call intent.
  const rec2 = recordingSender();
  await handleVoicePrompt(
    {
      conversationId: 'conv_handoff_3',
      transcript: 'still there?',
      abortSignal: new AbortController().signal,
      memory: undefined,
      session,
    },
    voiceDeps(fakeTurnDeps(['Yes.'], 'Yes.', events), rec2.sender),
  );
  expect(rec2.frames).toEqual([]);

  forgetHandoffSnapshot('conv_handoff_3');
});

test('a ZERO-TOKEN handoff turn sends exactly ONE frame, and it carries the payload', async () => {
  /**
   * THE REGRESSION TEST FOR A DOUBLE `{"type":"end"}`, and the reason the fake above now drains.
   *
   * Reachable in production: `maxSteps` is 3, and a turn that searches and then transfers can exhaust
   * the budget and produce no text at all. Before the fix, `consumeHandoffRequest` was read BELOW the
   * empty-answer block, so the sequence was — fallback text out, TAC's `sendResponse` drain sends the
   * parked frame, our drain then finds the intent, sees `parked === undefined`, and sends a SECOND bare
   * `{"type":"end"}`. Two end frames on one socket is undefined behaviour, and the `handoff` event
   * reported `hadPayload: false` for a transfer that did carry one.
   *
   * Run this test against the pre-fix ordering and it fails three ways: `rec.frames` has length 2, the
   * second entry is `{"type":"end"}`, and `rec.spoken` holds the fallback line.
   */
  const events: ObsEvent[] = [];
  // Zero deltas AND empty text: the turn produced nothing to say.
  const turn = fakeTurnDeps([], '', events);
  const { session } = await requestHandoff('conv_handoff_5', 'caller asked for a person');
  const rec = recordingSender({ session: session as unknown as { pendingHandoffData?: unknown } });
  const parked = parkedFrame(session);

  await handleVoicePrompt(
    {
      conversationId: 'conv_handoff_5',
      transcript: 'just put me through to somebody',
      abortSignal: new AbortController().signal,
      memory: undefined,
      session,
    },
    voiceDeps(turn, rec.sender),
  );

  // ONE frame, and it is TAC's parked one. `toEqual` on the whole array is the assertion — a length
  // check alone would pass on the buggy ordering if the frames happened to be equal.
  expect(rec.frames).toEqual([parked]);
  // And nothing was SAID. A caller who has just asked for a person must not hear "Sorry, I didn't catch
  // that" and then be transferred; the end frame closes the talk cycle here, so the fallback is not
  // needed to close it either.
  expect(rec.spoken).toEqual([]);
  expect(rec.order).toEqual([`frame:${parked}`]);

  const published = events.find((e) => e.kind === 'handoff');
  expect(published?.payload).toMatchObject({ frameSent: true, hadPayload: true, farewell: '' });

  forgetHandoffSnapshot('conv_handoff_5');
});

test('interrupting the "putting you through" line cancels the transfer', async () => {
  const events: ObsEvent[] = [];
  const turn = fakeTurnDeps(['Putting you through.'], 'Putting you through.', events);
  const rec = recordingSender();
  const abort = new AbortController();
  const { session } = await requestHandoff('conv_handoff_4');
  abort.abort();

  await handleVoicePrompt(
    {
      conversationId: 'conv_handoff_4',
      transcript: 'wait, no',
      abortSignal: abort.signal,
      memory: undefined,
      session,
    },
    voiceDeps(turn, rec.sender),
  );

  expect(rec.frames).toEqual([]);

  // And the INTENT is gone, not merely skipped — otherwise the next turn transfers a caller who has
  // just objected. `session.pendingHandoffData` deliberately survives; see the comment at the
  // barge-in branch in `server/twilio/voice.ts` for why that asymmetry is correct.
  const rec2 = recordingSender();
  await handleVoicePrompt(
    {
      conversationId: 'conv_handoff_4',
      transcript: 'one more thing',
      abortSignal: new AbortController().signal,
      memory: undefined,
      session,
    },
    voiceDeps(fakeTurnDeps(['Of course.'], 'Of course.', events), rec2.sender),
  );
  expect(rec2.frames).toEqual([]);
  expect(events.some((e) => e.kind === 'handoff')).toBe(false);
});

test('the action URL is pinned, non-empty, and points at a path we own', () => {
  const opts = buildVoiceTwimlOptions('demo.ngrok.app');
  // Not a tautology: the ConversationRelay default changed to `none` in May 2025, which stops the
  // audio on a barge-in but never delivers the words that caused it — the agent goes deaf mid-call
  // and every pre-2025 example omits this attribute. `none` here would be a silent regression.
  expect(opts.reportInputDuringAgentSpeech).toBe('any');
  expect(opts.actionUrl).toBe(`https://demo.ngrok.app${VOICE_ACTION_PATH}`);
  // Verified in the 2.2.0 bundle, `generateTwiml` at `dist/index.js:5901`:
  // `response.connect(options.actionUrl ? { action: options.actionUrl } : {})`. An empty string is
  // falsy, so it DELETES the attribute and throws nothing — `TwiMLOptionsSchema.actionUrl` declares
  // `.min(1)` but never runs on `defaultTwimlOptions`, which is a plain interface. Hence the boot-time
  // throw, and hence this assertion.
  expect(() => buildVoiceTwimlOptions('')).toThrow(/publicDomain/);
  expect(() => buildVoiceTwimlOptions('   ')).toThrow(/publicDomain/);

  // A TRAILING SLASH IS LEGAL IN THE ENV VAR — `server/config.ts`'s `voiceSchema` rejects a scheme and
  // nothing else — and concatenating it with a path that already starts with `/` used to produce
  // `https://host//api/voice/relay-action`, which Fastify does not match. Twilio would 404 the action
  // POST and the caller would lose the transfer with nothing logged here to say why.
  expect(buildVoiceTwimlOptions('demo.ngrok.app/').actionUrl).toBe(
    `https://demo.ngrok.app${VOICE_ACTION_PATH}`,
  );
  expect(buildVoiceTwimlOptions('demo.ngrok.app///').actionUrl).toBe(
    `https://demo.ngrok.app${VOICE_ACTION_PATH}`,
  );
  // A base path is legal per TAC and must SURVIVE — only the trailing slash goes.
  expect(buildVoiceTwimlOptions('demo.example.com/server1/').actionUrl).toBe(
    `https://demo.example.com/server1${VOICE_ACTION_PATH}`,
  );
});
