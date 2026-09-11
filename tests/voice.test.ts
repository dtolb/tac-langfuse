import { test, expect } from 'vitest';
import { capabilities, loadConfig } from '../server/config.ts';
import { createHistory } from '../server/agent/history.ts';
import { passthroughMemory } from '../server/agent/memory.ts';
import { createToolCatalog } from '../server/agent/tools/catalog.ts';
import { resolve } from '../server/agent/tools/resolve.ts';
import type { ToolDef, ToolLogger } from '../server/agent/tools/registry.ts';
import type { ModelPort } from '../server/agent/model/port.ts';
import type { PromptPort } from '../server/agent/prompt/port.ts';
import type { TurnDeps } from '../server/agent/types.ts';
import { createObsBus } from '../server/obs/bus.ts';
import { endCallTool } from '../server/agent/tools/end-call.ts';
import type { ObsEvent } from '../shared/events.ts';
import { createConversationRegistry } from '../server/obs/conversations.ts';
import {
  handleVoiceDisconnect,
  handleVoicePrompt,
  VOICE_FALLBACK_TEXT,
  VOICE_TWIML_OPTIONS,
  type VoiceSender,
} from '../server/twilio/voice.ts';

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

const silentLogger: ToolLogger = { debug: () => {}, warn: () => {}, error: () => {} };

const promptPort: PromptPort = {
  get: async () => ({
    name: 'demo-agent-voice',
    version: 2,
    label: 'production',
    messages: [{ role: 'system', content: 'You are {{persona}}.' }],
    config: { model: 'gpt-test', tools: [], toolChoice: 'auto', maxSteps: 3 },
    telemetryLink: null,
  }),
};

const fakeTurnDeps = (
  deltas: string[],
  text: string,
  events: ObsEvent[],
): TurnDeps => {
  const bus = createObsBus();
  bus.subscribe((e) => events.push(e));
  const model: ModelPort = {
    stream: () => ({
      tokens: (async function* () {
        for (const d of deltas) {
          await new Promise((r) => void setTimeout(r, 5));
          yield d;
        }
      })(),
      done: Promise.resolve({
        text,
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        steps: 1,
      }),
    }),
  };
  return {
    prompts: promptPort,
    tools: (names, t) =>
      resolve(names, {
        capabilities: capabilities(loadConfig({})),
        catalog: createToolCatalog([] as ToolDef[]),
        logger: silentLogger,
        bus,
        conversationId: t.conversationId,
        channel: t.channel,
      }),
    model,
    composeMemory: passthroughMemory,
    obs: bus,
    spans: {
      timeStep: async (_n, fn) => fn(),
      startStep: () => ({ update: () => {}, end: () => {} }),
    },
    branding: { persona: 'Ada', companyName: 'Northwind Traders' },
    history: createHistory(),
    logger: silentLogger,
  };
};

/** Records what was sent, what signal it was sent with, and any raw frames written to the socket. */
const recordingSender = (
  opts: { socketOpen?: boolean } = {},
): {
  sender: VoiceSender;
  streamed: string[];
  spoken: string[];
  signals: (AbortSignal | undefined)[];
  frames: string[];
  order: string[];
} => {
  const streamed: string[] = [];
  const spoken: string[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const frames: string[] = [];
  /**
   * One ordered log across BOTH wires, because the property that matters is a sequence: the end
   * frame must come after every token. Two separate arrays can each look right while the order
   * between them is wrong, which is the actual bug (a truncated goodbye).
   */
  const order: string[] = [];
  const socketOpen = opts.socketOpen ?? true;
  return {
    streamed,
    spoken,
    signals,
    frames,
    order,
    sender: {
      async sendStreamingResponse(_id, stream, options) {
        signals.push(options?.signal);
        let all = '';
        for await (const chunk of stream) {
          // Honour the signal the way TAC does, so an aborted turn stops mid-stream here too.
          if (options?.signal?.aborted === true) break;
          all += chunk;
          streamed.push(chunk);
          order.push(`token:${chunk}`);
        }
        return all;
      },
      async sendResponse(_id, message) {
        spoken.push(message);
        order.push(`say:${message}`);
      },
      getWebsocket: () =>
        socketOpen
          ? {
              readyState: 1, // WebSocket.OPEN
              send: (data: string) => {
                frames.push(data);
                order.push(`frame:${data}`);
              },
            }
          : null,
    },
  };
};

/** Drive the end_call tool the way the model would, for the current conversation. */
const requestEndCall = async (conversationId: string, reason = 'caller said goodbye'): Promise<void> => {
  await endCallTool.execute(
    { reason },
    { conversationId, logger: silentLogger },
  );
};

const registry = (): ReturnType<typeof createConversationRegistry> =>
  createConversationRegistry({
    spanName: 'conversation.voice',
    start: () => ({ traceparent: undefined, update: () => {}, end: () => {} }),
  });

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
    { turn, conversations: registry(), sender: rec.sender, logger: silentLogger },
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
    { turn, conversations: registry(), sender: rec.sender, logger: silentLogger },
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
    { turn, conversations: registry(), sender: rec.sender, logger: silentLogger },
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
    { turn, conversations: registry(), sender: rec.sender, logger: silentLogger },
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
      { turn, conversations: registry(), sender, logger: silentLogger },
    ),
  ).resolves.toBeUndefined();

  expect(spoken).toEqual([VOICE_FALLBACK_TEXT]);
  expect(events.some((e) => e.kind === 'error')).toBe(true);
});

test('a disconnect ends the trace root and clears the transcript', async () => {
  const events: ObsEvent[] = [];
  const turn = fakeTurnDeps(['hi'], 'hi', events);
  const conversations = registry();
  turn.history.append('conv_voice_6', [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
  ]);
  conversations.traceparentFor('conv_voice_6');
  expect(conversations.size()).toBe(1);

  handleVoiceDisconnect({ conversationId: 'conv_voice_6' }, { turn, conversations });

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
    { turn, conversations: registry(), sender: rec.sender, logger: silentLogger },
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
    { turn, conversations: registry(), sender: rec.sender, logger: silentLogger },
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
    { turn, conversations: registry(), sender: rec.sender, logger: silentLogger },
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
    { turn: fakeTurnDeps(['Of course.'], 'Of course.', events), conversations: registry(), sender: rec2.sender, logger: silentLogger },
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
    { turn, conversations: registry(), sender: rec.sender, logger: silentLogger },
  );

  // Must not throw — the caller hanging up first is routine, not an error.
  expect(events.find((e) => e.kind === 'voice.end')?.payload).toMatchObject({ frameSent: false });
});

test('the TwiML default that keeps barge-in audible is set', () => {
  // Not a tautology: the ConversationRelay default changed to `none` in May 2025, which stops the
  // audio on a barge-in but never delivers the words that caused it — the agent goes deaf mid-call
  // and every pre-2025 example omits this attribute. `none` here would be a silent regression.
  expect(VOICE_TWIML_OPTIONS.reportInputDuringAgentSpeech).toBe('any');
});
