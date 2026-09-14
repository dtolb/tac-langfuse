import { test, expect } from 'vitest';
import { z } from 'zod';
import { createStudioHandoffTool } from 'twilio-agent-connect';
import {
  recordHandoffSnapshot,
  findHandoffSnapshot,
  forgetHandoffSnapshot,
  handoffSnapshotCount,
  HANDOFF_MAX_SNAPSHOTS,
} from '../server/handoff/snapshots.ts';
import { handoffTool, consumeHandoffRequest, forgetHandoffRequest } from '../server/twilio/handoff.ts';
import type { ToolCtx, ToolLogger } from '../server/agent/tools/registry.ts';
import { fakeTac, tacCalls, voiceSession } from './helpers/fake-tac.ts';

const snap = (conversationId: string, from: string | null, at: string) => ({
  conversationId,
  reason: `reason for ${conversationId}`,
  from,
  at,
  transcript: [{ role: 'user' as const, text: 'I want a human' }],
});

/**
 * Empty the module-global store through its PUBLIC API — `findHandoffSnapshot({})` always returns the
 * newest entry, so no reset export and no mocking library is needed. Used by the test below that
 * asserts on an empty store, which would otherwise be passing only because the tests above it happen
 * to run first and clean up after themselves.
 */
const drainSnapshots = (): void => {
  while (handoffSnapshotCount() > 0) {
    const { snapshot } = findHandoffSnapshot({});
    if (snapshot === null) break;
    forgetHandoffSnapshot(snapshot.conversationId);
  }
};

test('an exact conversationId match beats a caller match', () => {
  recordHandoffSnapshot(snap('conv_a', '+15551110000', '2026-09-14T10:00:00.000Z'));
  recordHandoffSnapshot(snap('conv_b', '+15551110000', '2026-09-14T10:01:00.000Z'));

  const exact = findHandoffSnapshot({ conversationId: 'conv_a', from: '+15551110000' });
  expect(exact.match).toBe('exact');
  expect(exact.snapshot?.conversationId).toBe('conv_a');

  forgetHandoffSnapshot('conv_a');
  forgetHandoffSnapshot('conv_b');
});

test('a caller match picks the MOST RECENT snapshot for that number', () => {
  // Two calls from one number is the realistic redial, and the newer one is the live call.
  recordHandoffSnapshot(snap('conv_old', '+15552220000', '2026-09-14T10:00:00.000Z'));
  recordHandoffSnapshot(snap('conv_new', '+15552220000', '2026-09-14T10:05:00.000Z'));

  const found = findHandoffSnapshot({ from: '+15552220000' });
  expect(found.match).toBe('caller');
  expect(found.snapshot?.conversationId).toBe('conv_new');

  forgetHandoffSnapshot('conv_old');
  forgetHandoffSnapshot('conv_new');
});

test('an unknown number falls back to the most recent snapshot and SAYS it did', () => {
  // Studio's connect-call-to widget cannot pass parameters to a client, and dialling a client mints a
  // new CallSid — so `recent` is the honest disposition, not a bug. The UI renders the distinction.
  recordHandoffSnapshot(snap('conv_only', '+15553330000', '2026-09-14T10:00:00.000Z'));

  const found = findHandoffSnapshot({ from: '+19998887777' });
  expect(found.match).toBe('recent');
  expect(found.snapshot?.conversationId).toBe('conv_only');

  forgetHandoffSnapshot('conv_only');
});

test('an empty store reports none, not a throw', () => {
  drainSnapshots();
  expect(handoffSnapshotCount()).toBe(0);
  expect(findHandoffSnapshot({ from: '+15550000000' })).toEqual({ snapshot: null, match: 'none' });
});

test('the store is bounded, oldest-first', () => {
  for (let i = 0; i <= HANDOFF_MAX_SNAPSHOTS; i += 1) {
    recordHandoffSnapshot(snap(`conv_${i}`, `+1555000${String(i).padStart(4, '0')}`, '2026-09-14T10:00:00.000Z'));
  }
  expect(handoffSnapshotCount()).toBe(HANDOFF_MAX_SNAPSHOTS);
  // The first one in is the first one out.
  expect(findHandoffSnapshot({ conversationId: 'conv_0' }).match).not.toBe('exact');
  for (let i = 0; i <= HANDOFF_MAX_SNAPSHOTS; i += 1) forgetHandoffSnapshot(`conv_${i}`);
});

// ------------------------------------------------------------------ the tool

const silentLogger: ToolLogger = { debug: () => {}, warn: () => {}, error: () => {} };
const ctx = (conversationId: string): ToolCtx => ({
  conversationId,
  logger: silentLogger,
  profileId: 'profile_test',
});

test('the tool parks a complete end frame on the session and records the reason', async () => {
  const tac = fakeTac();
  const session = voiceSession('conv_tool_1', tacCalls(tac));
  const tool = handoffTool({ tac, sessions: { getConversationSession: () => session } });

  expect(tool.name).toBe('handoff');
  expect(tool.requires).toBe('handoff');

  const result = await tool.execute({ reason: 'caller asked for a person' }, ctx('conv_tool_1'));

  // The frame is READY TO SEND, not raw data — `{type:'end', handoffData:"<json>"}`. The double
  // encoding is required: Twilio documents handoffData as a JSON-encoded STRING.
  const parked = (session as unknown as { pendingHandoffData?: { type: string; handoffData: string } })
    .pendingHandoffData;
  expect(parked?.type).toBe('end');
  const payload = JSON.parse(parked?.handoffData ?? '{}');
  expect(payload).toMatchObject({ conversationId: 'conv_tool_1', storeId: 'store_test', profileId: 'profile_test' });
  // `attributes` is the ONLY extension point — the payload's other three keys are fixed — so
  // reasonCode rides inside it, and the model's reason always overwrites a static one.
  // `live-agent-handoff` is TWILIO'S OWN documented reasonCode for this, and its action-handler
  // example branches on exactly that string. Do not invent a house value.
  expect(payload.attributes).toEqual({ reasonCode: 'live-agent-handoff', reason: 'caller asked for a person' });

  // Addressed to the model, mirroring end_call: it must say one line and stop.
  expect(result).toMatchObject({ transferring: true });

  // The intent is what `voice.ts` consumes AFTER the farewell has streamed.
  expect(consumeHandoffRequest('conv_tool_1')).toBe('caller asked for a person');
  expect(consumeHandoffRequest('conv_tool_1')).toBeNull();
});

test('TAC sets the conversation INACTIVE and clears status callbacks BEFORE parking the frame', async () => {
  const tac = fakeTac();
  const session = voiceSession('conv_tool_2', tacCalls(tac));
  const tool = handoffTool({ tac, sessions: { getConversationSession: () => session } });

  await tool.execute({ reason: 'escalation' }, ctx('conv_tool_2'));

  // THREE entries in ONE array, and the park is the third — that is what makes this an ordering
  // assertion rather than three existence assertions. `tests/helpers/fake-tac.ts` records the park via
  // an accessor on `pendingHandoffData` for exactly this reason. Measured, not assumed: parking the
  // frame ahead of the two awaits in the vendor bundle turns this red (and was reverted).
  //
  // Both Orchestrator calls are warn-only inside TAC and neither has an inverse. On the SUCCESS path
  // Studio flips the status back to ACTIVE on pickup; the unreverted-INACTIVE landmine is the FAILURE
  // path, which is exactly what sending the frame eliminates. Design doc §2.5.
  expect(tacCalls(tac)).toEqual(['update:conv_tool_2:INACTIVE', 'clear:conv_tool_2', 'park:conv_tool_2']);
  forgetHandoffRequest('conv_tool_2');
});

test('a missing session is a structured miss, never a throw', async () => {
  const tool = handoffTool({ tac: fakeTac(), sessions: { getConversationSession: () => undefined } });
  const result = await tool.execute({ reason: 'x' }, ctx('conv_tool_3'));
  expect(result).toMatchObject({ found: false });
  expect(consumeHandoffRequest('conv_tool_3')).toBeNull();
});

test("an unset flow SID is a miss, not a boot crash — construction is lazy", async () => {
  // TAC's first guard throws at CONSTRUCTION. Constructing inside `execute` is what turns that into
  // something the model can speak about instead of dead air.
  const tac = fakeTac({ flowSid: null });
  const session = voiceSession('conv_tool_4', tacCalls(tac));
  const tool = handoffTool({ tac, sessions: { getConversationSession: () => session } });
  const result = await tool.execute({ reason: 'x' }, ctx('conv_tool_4'));
  expect(result).toMatchObject({ found: false });
  expect(consumeHandoffRequest('conv_tool_4')).toBeNull();
  // Nothing happened at all: the guard fires before the first Orchestrator call.
  expect(tacCalls(tac)).toEqual([]);
});

// ------------------------------------------------------------------ schema drift

/**
 * The house pattern from `tests/builtin-tools.test.ts` — deep-equal our Zod mirror, projected to JSON
 * Schema, against the vendor's own `parameters` — with a different set of normalisations, because this
 * mirror differs from those two in three ways:
 *
 *  - `$schema` is stripped for the same reason there — Zod stamps it, TAC writes no such key.
 *  - `required` needs no defaulting: both sides say `['reason']`.
 *  - The TOP-LEVEL `description` is deliberately COMPARED here, where `builtin-tools.test.ts` has to
 *    strip it. TAC hard-codes this schema and never echoes `options.description` into it
 *    (`dist/index.js:6455-6466`), so the comparison is not circular, and the string is 39 characters
 *    rather than 900 — cheap enough to also send to the model.
 *  - `minLength` IS stripped, and that is a real difference rather than a spelling one: our mirror is
 *    `z.string().min(1)` where TAC's JSON Schema has no bound at all, so `reason: ''` is a mid-turn
 *    validation failure for us and would be accepted by TAC. Deliberate — an empty reason renders as a
 *    blank line on the human's screen pop — and `server/twilio/handoff.ts` records it at the mirror.
 *    Stripped from BOTH sides so the comparison stays symmetric, and covered instead by the
 *    `safeParse('')` assertion below.
 */
const normalise = (schema: unknown): Record<string, unknown> => {
  const copy = structuredClone(schema) as Record<string, unknown>;
  delete copy.$schema;
  const properties = copy.properties as Record<string, Record<string, unknown>> | undefined;
  if (properties?.reason !== undefined) delete properties.reason.minLength;
  return copy;
};

test("the mirror matches TAC's own JSON Schema, so a schema drift is caught here", () => {
  const def = handoffTool({ tac: fakeTac(), sessions: { getConversationSession: () => undefined } });
  const tac = fakeTac();
  // TAC's REAL factory, against the installed bundle. `parameters` does not depend on the session or
  // on `options`, so the fake handle and a fake session are enough to read the vendor's schema out —
  // and a release that renamed `reason` to anything else now fails HERE rather than silently sending
  // `reason: undefined` on every live transfer.
  const tacTool = createStudioHandoffTool(tac, voiceSession('conv_drift', tacCalls(tac)), {
    name: def.name,
    description: def.description,
    attributes: { reasonCode: 'live-agent-handoff' },
  });

  expect(normalise(z.toJSONSchema(def.input, { io: 'input' }))).toEqual(normalise(tacTool.parameters));
});

test('the mirror rejects an empty reason, which is where it deliberately differs from TAC', () => {
  // The half a deep-equal cannot show: that the mirror VALIDATES, and that the one stripped key above
  // is load-bearing rather than cosmetic. `defineTool` performs no argument validation, so this is the
  // only gate in front of TAC's implementation.
  const input = handoffTool({ tac: fakeTac(), sessions: { getConversationSession: () => undefined } }).input;
  expect(input.safeParse({}).success).toBe(false);
  expect(input.safeParse({ reason: '' }).success).toBe(false);
  expect(input.safeParse({ reason: 'caller asked for a human' }).success).toBe(true);
});
