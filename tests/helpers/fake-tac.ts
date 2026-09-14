/**
 * A fake TAC handle, used to exercise TAC's REAL `createStudioHandoffTool`.
 *
 * That is the point of it: the voice branch touches exactly four things on the handle, so a fake is
 * honest here in a way that mocking our own tool would not be — it proves TAC's three construction
 * guards and the parked frame's exact shape against the installed vendor bundle.
 *
 * Shared by `tests/handoff.test.ts` and `tests/voice.test.ts` rather than copied into each. `calls`
 * records the Conversation Orchestrator side effects in order, which is what proves INACTIVE and
 * clearStatusCallbacks happen BEFORE the frame is parked.
 */
import type { TAC } from 'twilio-agent-connect';

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
