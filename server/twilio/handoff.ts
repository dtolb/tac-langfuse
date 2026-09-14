/**
 * `handoff` — the tool that transfers a caller to a human, and the third TAC built-in we adapt.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THIS TOOL DOES NOT TRANSFER THE CALL. IT RECORDS AN INTENT AND PARKS A FRAME.
 *
 * The same argument as `../agent/tools/end-call.ts`, and the same shape: a tool runs INSIDE the model
 * loop, before the turn's text exists, so transferring here cuts the caller off mid-sentence — before
 * the model has even written the line that says what is about to happen. `execute` therefore does two
 * things and neither of them touches the WebSocket: it delegates to TAC, which parks a ready-made
 * `{type:'end', handoffData}` frame on the session, and it records the reason. `./voice.ts` sends the
 * frame after the farewell has streamed.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * WHY TAC'S TOOL RATHER THAN OUR OWN FRAME. `session.pendingHandoffData` is a COMPLETE frame, not raw
 * data (`dist/index.js:6487-6490`), and TAC's tool also does the two Conversation Orchestrator
 * side-effects a hand-built frame would silently skip: `updateConversation(..., 'INACTIVE')` and
 * `clearStatusCallbacks(...)`. What TAC omits is the DRAIN on a streaming channel — its own five-line
 * drain lives inside `sendResponse` (`dist/index.js:5245-5254`) and `sendStreamingResponse` has zero
 * references to the field. So the split is: TAC builds, we send. Design doc §2.4.
 *
 * WHY CONSTRUCTION IS LAZY, inside `execute`, exactly like `./builtin-tools.ts`: TAC's factory has
 * three guards that THROW at construction (flow SID, Conversation Orchestrator, memory store id). At
 * boot that is a crash; inside `execute` it is a structured miss the model can speak about.
 *
 * VOICE-ONLY BY PROMPT, and deliberately — see `../agent/prompt/defaults.ts`. TAC's tool branches
 * internally on `session.channel === 'voice'` and the digital branch works, but it POSTs to the Studio
 * Executions endpoint and only THEN can fail, having already set the conversation INACTIVE and cleared
 * its status callbacks with no inverse anywhere in TAC. On SMS that leaves a customer whose next text
 * reaches nothing. The frame-sending work in this task mitigates that failure path on voice; nothing
 * mitigates it on SMS, so the text prompt does not name this tool.
 */
import { createStudioHandoffTool, type ConversationSession, type TAC } from 'twilio-agent-connect';
import { z } from 'zod';
import { TAC_TOOL_NAMES } from '../../shared/tac-tool-names.ts';
import type { ToolDef, ToolLogger } from '../agent/tools/registry.ts';

/**
 * Index 2, and `shared/tac-tool-names.ts` says why the list is append-only: `./builtin-tools.ts`
 * reads 0 and 1 positionally. Same string as `BuiltInTools.HANDOFF`, which `tests/handoff.test.ts`
 * pins so the coincidence stays deliberate rather than becoming a stale copy.
 */
const HANDOFF_NAME = TAC_TOOL_NAMES[2];

/**
 * OURS, and it is load-bearing for the same reason `search_knowledge`'s is. This is the string the model
 * actually reads, as `ToolDef.description` — not the copy handed to `createStudioHandoffTool` in
 * `execute`, which reaches nothing.
 *
 * TAC's default — "Use this when the customer requests a human, or when you cannot adequately handle
 * the request" — invites a transfer whenever the model feels stuck. On a demo that means transferring
 * instead of searching the policy library, which is the one behaviour that makes the whole knowledge
 * feature look broken. So this description names the alternative explicitly.
 *
 * The WHEN also lives in the Langfuse-versioned prompt, which is what makes it tunable in front of a
 * customer without a redeploy. This string is the floor, not the whole policy.
 */
const HANDOFF_DESCRIPTION =
  'Transfer this phone call to a human colleague, ending your own part of the conversation. Use it ' +
  'when the caller asks to speak to a person, or when they are upset enough that a person should ' +
  'take over. Do NOT use it because a question is hard: look the answer up first — policy questions ' +
  'are answered by searching the written policies, and order questions by looking the order up. Do ' +
  'not use it to end a call that is simply finished; that is what ending the call is for. Once you ' +
  'call this, say one short line telling the caller you are putting them through, and nothing else.';

/**
 * The mirror of TAC's own parameter schema (`dist/index.js:6455-6466`), including the object-level
 * description, so `tests/handoff.test.ts` deep-equals this against
 * `createStudioHandoffTool(...).parameters` — the vendor's real declaration, read out of the installed
 * bundle. That comparison is the only thing standing between a renamed TAC field and a live transfer
 * that quietly sends `reason: undefined`, because TAC merges `{...staticAttributes, reason:
 * params.reason}` and `defineTool` validates nothing.
 *
 * Unlike `search_knowledge`'s mirror, the top-level `.describe()` is kept: TAC hard-codes this
 * schema and never echoes `options.description` into it, so there is no circularity and no duplicated
 * prose — the string is 39 characters rather than 900.
 *
 * ONE DELIBERATE DIVERGENCE: `.min(1)`. TAC's schema declares no `minLength`, so `reason: ''` would be
 * accepted there and is a mid-turn validation failure here. Kept because the reason is rendered on a
 * human's screen pop (`server/handoff/snapshots.ts`) and a blank one is worse than no handoff at all —
 * the drift test normalises `minLength` off both sides and pins the behaviour with a `safeParse('')`
 * assertion instead, so this stays visible rather than merged into the deep-equal.
 */
const HandoffInput = z
  .object({
    reason: z.string().min(1).describe('The reason for handing off to a human agent'),
  })
  .describe('Hand off the conversation to a human agent');

/**
 * `attributes` is the ONLY extension point on the payload — its other three keys (`conversationId`,
 * `storeId`, `profileId`) are built by TAC from the session. `reasonCode` is Twilio's convention for
 * naming a handoff cause, so it rides in here, and `live-agent-handoff` is the value Twilio's own
 * documentation uses — its action-handler example branches on that exact string, so our route can too. Note TAC merges as
 * `{...staticAttributes, reason: params.reason}`, so the model's reason always wins over a static one
 * of the same name — do not put a `reason` key here expecting it to survive.
 */
const HANDOFF_ATTRIBUTES = { reasonCode: 'live-agent-handoff' } as const;

/**
 * Bounded, for the same reason `end-call.ts`'s store is: `consume` is only ever called by the voice
 * handler, so a prompt naming this tool on a channel that ignores it would add entries nothing
 * removes.
 */
const MAX_PENDING = 100;

/** conversationId → the reason the model gave. */
const pending = new Map<string, string>();

/**
 * The two members of `VoiceChannel` this file needs, narrowed the way `./voice.ts` narrows its sender.
 *
 * METHOD SYNTAX, not a property, and the reason is worth keeping even though nothing depends on it yet.
 * TAC declares `getConversationSession(id: ConversationId)` with a BRANDED string; TypeScript checks
 * method parameters bivariantly, so a `VoiceChannel` would satisfy this interface as written, where a
 * property (`getConversationSession: (id: string) => ...`) is checked contravariantly and would be
 * rejected. The only call site does NOT exercise that: `./tac.ts` passes an object literal whose getter
 * reads a possibly-null channel and widens the id to `ConversationId` itself. So the method form buys
 * the option of handing a channel straight in, not something already relied on.
 *
 * `getConversationSession` is public on `BaseChannel`, so it comes off the CHANNEL and not off `TAC` —
 * the design doc records the opposite claim in `docs/HANDOFF.md` as one of its corrections.
 */
export interface HandoffSessionSource {
  getConversationSession(conversationId: string): ConversationSession | undefined;
}

export interface HandoffToolDeps {
  /**
   * The real handle, not a narrowed interface. `createStudioHandoffTool` takes a `TAC` and reads four
   * things off it (`getConfig`, `getConversationClient`, `getMemoryStoreId`, `logger`), so narrowing
   * would force a cast around the one contract this file exists to honour — the same reasoning
   * `./builtin-tools.ts` gives for typing its clients with TAC's own classes.
   */
  readonly tac: TAC;
  readonly sessions: HandoffSessionSource;
}

/** The structured-miss shape, one convention across the whole catalog. See `./builtin-tools.ts`. */
const miss = (message: string): { readonly found: false; readonly message: string } => ({
  found: false,
  message,
});

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function handoffTool(deps: HandoffToolDeps): ToolDef<typeof HandoffInput> {
  return {
    name: HANDOFF_NAME,
    description: HANDOFF_DESCRIPTION,
    input: HandoffInput,
    /**
     * `handoff` is `orchestrated && studioHandoffFlowSid !== null` — the capability already existed in
     * `server/config.ts` and this is the first tool to claim it. A process without it offers nothing:
     * `resolve()` reports `unavailable` with one debug line and the turn proceeds.
     */
    requires: 'handoff',
    async execute({ reason }, ctx) {
      const log = (level: keyof ToolLogger, fields: Record<string, unknown>, msg: string): void =>
        ctx.logger[level]({ tool: HANDOFF_NAME, conversationId: ctx.conversationId, ...fields }, msg);

      const session = deps.sessions.getConversationSession(ctx.conversationId);
      if (session === undefined) {
        // The session is created before TAC dispatches a prompt, so this means the socket closed
        // between the model deciding to transfer and the tool running — the caller hung up.
        log('warn', {}, 'handoff: no TAC session for this conversation, so there is nothing to transfer');
        return miss(
          'The call could not be transferred just now. Tell the caller you cannot put them through ' +
            'and offer to have a colleague call them back.',
        );
      }

      try {
        // `attributes` is the only one of these three options that changes anything we observe. We read
        // exactly ONE field off the returned tool — `.implementation` — and TAC's `name`/`description`
        // go nowhere but the `TACTool` we discard (`defineTool`, `dist/index.js:6265-6279`, only stores
        // them). What the model reads is `ToolDef.name` / `ToolDef.description` above. They are passed
        // for symmetry, so a reader diffing our tool against TAC's sees one contract, not two.
        const tool = createStudioHandoffTool(deps.tac, session, {
          name: HANDOFF_NAME,
          description: HANDOFF_DESCRIPTION,
          attributes: HANDOFF_ATTRIBUTES,
        });
        const result = await tool.implementation({ reason });

        if (result.status === 'handoff_failed') {
          // Only reachable on a digital channel — the voice branch cannot fail, it just assigns the
          // frame. Kept because the tool is channel-agnostic and a silent `handoff_failed` would leave
          // the conversation INACTIVE with nobody coming.
          log('warn', { error: result.error, channel: result.channel }, 'handoff: TAC could not deliver the handoff');
          return miss(
            'The transfer did not go through. Tell the caller you cannot put them through and offer ' +
              'to have a colleague call them back.',
          );
        }

        if (pending.size >= MAX_PENDING) {
          const oldest = pending.keys().next();
          if (oldest.done !== true) pending.delete(oldest.value);
        }
        pending.set(ctx.conversationId, reason);
        log(
          'debug',
          { reason, channel: result.channel },
          'handoff: frame parked on the session; the channel will send it after this turn is spoken',
        );

        // Addressed to the model. Saying the transfer is already happening is what stops it asking a
        // question it will never hear the answer to.
        return {
          transferring: true,
          instruction:
            'You are being connected to a colleague now. Say one short line telling the caller you ' +
            'are putting them through — no questions, no offers of further help.',
        };
      } catch (err) {
        // TAC's three construction guards and the Orchestrator round-trips share one catch: all fail
        // for reasons outside the process and the model's next move is identical either way.
        log('warn', { error: errorMessage(err) }, 'handoff: could not start the transfer');
        return miss(
          'The call could not be transferred just now. Tell the caller you cannot put them through ' +
            'and offer to have a colleague call them back.',
        );
      }
    },
  };
}

/**
 * Read and clear the intent for one conversation. Returns the reason, or `null` if none was set.
 *
 * Clearing on read makes the transfer fire exactly once, and means the store self-empties on the happy
 * path — the same contract as `consumeEndCallRequest`.
 */
export function consumeHandoffRequest(conversationId: string): string | null {
  const reason = pending.get(conversationId);
  if (reason === undefined) return null;
  pending.delete(conversationId);
  return reason;
}

/** Drop any intent for a conversation that ended some other way — a hangup, a sweep, a shutdown. */
export function forgetHandoffRequest(conversationId: string): void {
  pending.delete(conversationId);
}
