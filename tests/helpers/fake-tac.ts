/**
 * A fake TAC handle and a fake voice session, used to exercise TAC's REAL `createStudioHandoffTool`.
 *
 * That is the point of it: the voice branch touches exactly four things on the handle, so a fake is
 * honest here in a way that mocking our own tool would not be — it proves TAC's three construction
 * guards and the parked frame's exact shape against the installed vendor bundle.
 *
 * Lives in `helpers/` rather than inside `tests/handoff.test.ts` because the voice drain in T14b.3
 * needs the same two fakes.
 *
 * ONE ORDERED ARRAY RECORDS ALL THREE SIDE EFFECTS — the two Conversation Orchestrator calls AND the
 * frame being parked. That is what lets a test assert the park happens LAST; two separate recorders
 * (a `calls` array plus a plain `pendingHandoffData` field) can only show that all three happened.
 */
import type { ConversationSession, TAC } from 'twilio-agent-connect';

export const fakeTac = (over: { flowSid?: string | null; storeId?: string | null } = {}): TAC => {
  const calls: string[] = [];
  const tac = {
    getConfig: () => ({
      studioHandoffFlowSid: over.flowSid === undefined ? 'FW' + 'a'.repeat(32) : over.flowSid,
      phoneNumber: '+15550001111',
      apiKey: 'SK' + 'b'.repeat(32),
      apiSecret: 'secret',
    }),
    getConversationClient: () => ({
      updateConversation: async (id: string, status: string) => {
        calls.push(`update:${id}:${status}`);
      },
      clearStatusCallbacks: async (id: string) => {
        calls.push(`clear:${id}`);
      },
    }),
    getMemoryStoreId: () => (over.storeId === undefined ? 'store_test' : over.storeId),
    logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
    calls,
  };
  return tac as unknown as TAC;
};

/** The ordered side-effect log for a fake handle. Keeps the cast in one place. */
export const tacCalls = (tac: TAC): string[] => (tac as unknown as { calls: string[] }).calls;

/**
 * A voice session shaped like the one `VoiceChannel` hands out, wired to the same ordered log.
 *
 * `calls` is REQUIRED rather than optional: a session built without it silently stops constraining
 * ordering, which is the bug this argument exists to prevent.
 *
 * `pendingHandoffData` is an accessor, not a field, so the assignment TAC makes
 * (`session.pendingHandoffData = pending`, `dist/index.js:6487-6490`) both lands in the log as
 * `park:<conversationId>` and stays readable for the frame-shape assertions.
 */
export const voiceSession = (conversationId: string, calls: string[]): ConversationSession => {
  let parked: unknown;
  const session: Record<string, unknown> = {
    conversationId,
    channel: 'voice',
    profileId: 'profile_test',
    startedAt: new Date('2026-09-14T10:00:00.000Z'),
    authorInfo: { address: '+15554443333' },
    metadata: {},
  };
  Object.defineProperty(session, 'pendingHandoffData', {
    enumerable: true,
    get: () => parked,
    set: (value: unknown) => {
      parked = value;
      calls.push(`park:${conversationId}`);
    },
  });
  return session as unknown as ConversationSession;
};
