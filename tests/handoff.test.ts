import { test, expect } from 'vitest';
import type { ConversationSession } from 'twilio-agent-connect';
import {
  recordHandoffSnapshot,
  findHandoffSnapshot,
  forgetHandoffSnapshot,
  handoffSnapshotCount,
  HANDOFF_MAX_SNAPSHOTS,
} from '../server/handoff/snapshots.ts';
import { handoffTool, consumeHandoffRequest, forgetHandoffRequest } from '../server/twilio/handoff.ts';
import type { ToolCtx, ToolLogger } from '../server/agent/tools/registry.ts';
import { fakeTac } from './helpers/fake-tac.ts';

const snap = (conversationId: string, from: string | null, at: string) => ({
  conversationId,
  reason: `reason for ${conversationId}`,
  from,
  at,
  transcript: [{ role: 'user' as const, text: 'I want a human' }],
});

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

const voiceSession = (conversationId: string): ConversationSession =>
  ({
    conversationId,
    channel: 'voice',
    profileId: 'profile_test',
    startedAt: new Date('2026-09-14T10:00:00.000Z'),
    authorInfo: { address: '+15554443333' },
    metadata: {},
  }) as unknown as ConversationSession;

test('the tool parks a complete end frame on the session and records the reason', async () => {
  const session = voiceSession('conv_tool_1');
  const tac = fakeTac();
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
  const session = voiceSession('conv_tool_2');
  const tac = fakeTac();
  const tool = handoffTool({ tac, sessions: { getConversationSession: () => session } });

  await tool.execute({ reason: 'escalation' }, ctx('conv_tool_2'));

  // Both are warn-only inside TAC and neither has an inverse. On the SUCCESS path Studio flips the
  // status back to ACTIVE on pickup; the unreverted-INACTIVE landmine is the FAILURE path, which is
  // exactly what sending the frame eliminates. Design doc §2.5.
  expect((tac as unknown as { calls: string[] }).calls).toEqual([
    'update:conv_tool_2:INACTIVE',
    'clear:conv_tool_2',
  ]);
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
  const tool = handoffTool({
    tac: fakeTac({ flowSid: null }),
    sessions: { getConversationSession: () => voiceSession('conv_tool_4') },
  });
  const result = await tool.execute({ reason: 'x' }, ctx('conv_tool_4'));
  expect(result).toMatchObject({ found: false });
  expect(consumeHandoffRequest('conv_tool_4')).toBeNull();
});

test('the mirror matches what TAC declares, so a schema drift is caught here', () => {
  const tool = handoffTool({ tac: fakeTac(), sessions: { getConversationSession: () => undefined } });
  expect(tool.input.safeParse({}).success).toBe(false);
  expect(tool.input.safeParse({ reason: 'caller asked for a human' }).success).toBe(true);
});
