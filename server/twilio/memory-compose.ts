/**
 * The TAC-backed `MemoryComposePort` — a Conversation Orchestrator recall, folded into extra
 * system-prompt context.
 *
 * `passthroughMemory` (`server/agent/memory.ts`) is the sibling the bench and
 * SMS-without-orchestration run on. Both honour the same two contract points:
 *
 *  1. **Returns `null`, never `''`.** An empty string is appended to the system prompt as a blank
 *     paragraph, and "no memory" should be indistinguishable from "no memory port".
 *     `composeTurn` (`run-turn.ts:110`) guards `!== ''` too; that is belt-and-braces on purpose,
 *     since neither file can see the other's half of it.
 *  2. **Never throws.** try/catch → log → `null`, the same never-rejects contract
 *     `agent/prompt/langfuse.ts` holds to. Memory is an enhancement and must not be able to end a
 *     phone call.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS AT ALL: to make `## Recent Message History` UNREACHABLE.
 *
 * `server/agent/history.ts` already puts this conversation's exchange into the model's MESSAGES.
 * If a recall response's communications also reach the system prompt, the model sees the same
 * conversation twice in two formats — worse answers, not merely wasted tokens.
 *
 * `memoryConfig.communicationsLimit` protects only the happy path. It defaults to 0
 * (`packages/core/src/types/config.ts:19`), it is process-wide rather than per-channel, and
 * decisively: **the Recall-failure fallback ignores it.** On any throw from the memory path
 * `packages/core/src/lib/tac.ts:597-605` calls `conversationClient.listCommunications(
 * session.conversationId)`, whose signature takes no limit, and hands the result to the same
 * `TACMemoryResponse` — which renders `## Recent Message History` of `User:` / `Assistant:` lines
 * from the CURRENT conversation. No config value can reach that path. Zeroing communications here
 * covers both, which is why the guard lives in our code rather than in TAC's configuration.
 *
 * It is enforced in two places below, both marked `THE GUARD`:
 *   half 1 — `RECALL_SECTIONS` has no `communications` key, so zod strips it on the way in;
 *   half 2 — the response handed to the renderer is CONSTRUCTED with `communications: []`.
 * Half 1 is sufficient today and half 2 is what still stands if a future edit widens the parse —
 * which is the realistic regression, since "the schema is missing a field" reads like a bug to
 * anyone who has not read this. Removing BOTH was measured, and it renders exactly the
 * double-visible history described above; `tests/memory-compose.test.ts` carries the failure text.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ONE OF THE FILES ALLOWED TO IMPORT TAC (`tests/architecture.test.ts` enforces the boundary), and
 * it imports it STATICALLY. So it must be reached only from `./tac.ts`, which `server/index.ts`
 * imports dynamically — a static import of this module from the boot path would load TAC into a
 * process with no Twilio credentials, which is the one thing that dynamic import buys.
 */
import {
  MemoryPromptBuilder,
  MemoryRetrievalResponseSchema,
  TACMemoryResponse,
  type ConversationSession,
  type Profile,
} from 'twilio-agent-connect';
import type { ToolLogger } from '../agent/tools/registry.ts';
import type { MemoryComposePort, TurnChannel } from '../agent/types.ts';
import { childLogger } from '../logging.ts';
import { obsBus, type ObsBus } from '../obs/bus.ts';

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The observations and summaries of a recall, and NOTHING else. **THE GUARD, half 1.**
 *
 * `communications` is not a key here, so zod strips it: no communication can survive the parse, and
 * the `TACCommunication[]` the renderer would need therefore cannot be assembled from our input at
 * all. Derived from TAC's own schema with `.pick()` rather than hand-written, so an upgrade that
 * changes an observation's shape changes this with it instead of drifting from it.
 *
 * Measured against the installed 2.2.0 bundle: this parses a real `TACMemoryResponse` instance
 * (through its `observations` / `summaries` getters) and a plain object literal of the same shape
 * IDENTICALLY. That is what lets the test feed a literal and still drive TAC's real renderer.
 *
 * Do not "complete" this by adding `communications: true`. Measured, that does not leak them — it
 * breaks the WHOLE parse and loses the observations too, because the key this schema types as
 * `MemoryCommunicationSchema` is fed by `TACMemoryResponse.communications`, which returns the
 * unified `TACCommunication` shape instead, and the two disagree on the author (`address` +
 * `channel` versus a memory participant).
 *
 * Whole-object rather than per-item, unlike TAC's own client, and that is safe because of what the
 * client already did: `packages/core/src/clients/memory.ts:110-130` parses every observation and
 * summary independently against these same two schemas before building the response. Anything that
 * reaches us has already passed them, so a failure here means the payload was not a recall at all —
 * for which discarding the lot is the right answer.
 */
const RECALL_SECTIONS = MemoryRetrievalResponseSchema.pick({
  observations: true,
  summaries: true,
});

/**
 * Our channel names onto TAC's `ChannelType`.
 *
 * Used for exactly one thing: filling in `ConversationSession.channel` on the render context. TAC's
 * profile renderer never reads it — `buildProfilePrompt`
 * (`packages/core/src/lib/conversation-session-helpers.ts:46`) touches `context.profile` and
 * nothing else — the field exists because `ConversationSession` requires it.
 *
 * `bench` has no TAC equivalent. It is also unreachable past the first guard in `compose`, because
 * the bench harness sends no memory payload; `chat` is the nearest analogue for a text-in/text-out
 * surface. A `Record<TurnChannel, …>` rather than a switch so adding a channel is a compile error
 * here rather than a silent `undefined` in a vendor object.
 */
const TAC_CHANNEL: Record<TurnChannel, ConversationSession['channel']> = {
  voice: 'voice',
  sms: 'sms',
  bench: 'chat',
};

/**
 * The ONE method this port calls on the TAC handle. `TAC` satisfies it structurally.
 *
 * Narrow for the same reason `VoiceSender` in `./voice.ts` is narrow: it states exactly what this
 * file touches, and it makes the test fake three lines instead of a mocking library. Everything
 * else this port does — the parse, the guard, the rendering — runs the REAL vendor code in tests,
 * which is the only way the guard's test can bite.
 *
 * `traits` is optional here and required on TAC's `ProfileResponse`
 * (`packages/core/src/types/memory.ts:220-224`); required is assignable to optional, and declaring
 * it optional means a fake need not invent one.
 */
export interface ProfileFetcher {
  fetchProfile(profileId: string): Promise<{ readonly traits?: Record<string, unknown> } | undefined>;
}

export interface TacMemoryDeps {
  /** Structural, so `childLogger('memory')` fits and a test can collect lines instead. */
  readonly logger?: ToolLogger;
  readonly bus?: Pick<ObsBus, 'publish'>;
  /** Injected so the reported `profileMs` is exact in tests rather than tolerant of a wall clock. */
  readonly now?: () => number;
}

/**
 * Wrap the live TAC handle as a `MemoryComposePort`.
 *
 * NO SPAN IS CREATED HERE, and the profile fetch — the only real I/O in the file — does not get one
 * either. Three reasons, in order of weight:
 *
 *  1. `run-turn.ts:210-220` already wraps this whole port in a `memory.recall` timed step reporting
 *     `chars`. When a profile is fetched that fetch is essentially the entire duration of the step,
 *     so a child span would report the same number under a second name.
 *  2. A span started from in here would not nest under `memory.recall` anyway. `startStep` uses
 *     `startObservation`, which parents to the AMBIENT context and does not make itself active
 *     (`server/obs/spans.ts:132`), so `memory.recall` is not active while we run and our child
 *     would attach to the turn as a SIBLING of it — a waterfall that lies about nesting.
 *  3. The cost is still reported, as `profileMs` on this port's own `memory.recall` obs event, which
 *     is what distinguishes "the step took 180 ms fetching a profile" from "the step took 180 ms
 *     doing something else". `run-turn.ts:201-203` sets the convention: the port that does the work
 *     owns its event, `runTurn` owns the span.
 *
 * If `profileMs` ever turns out to dominate `memory.recall`, the honest fix is a child step created
 * by `run-turn.ts` — not one created here.
 */
export function createTacMemoryPort(tac: ProfileFetcher, deps: TacMemoryDeps = {}): MemoryComposePort {
  const logger = deps.logger ?? childLogger('memory');
  const bus = deps.bus ?? obsBus;
  const now = deps.now ?? Date.now;

  /**
   * `## Customer Profile` is the part that makes memory feel personal, and it is entirely ours to
   * fetch: `ConversationSession.profile` is optional and NOTHING in TAC ever assigns it (zero
   * assignments across `packages/` at 2.2.0), the recall response carries no traits
   * (`MemoryRetrievalResponseSchema` is observations/summaries/communications/meta), and
   * `tac.fetchProfile` is public with no internal callers.
   *
   * ONE FILTER, NOT TWO. The fetch is filtered by `memoryConfig.traitGroups`
   * (`packages/core/src/lib/tac.ts:632`) and the render by `AdapterOptions.profileTraits`; two
   * filters that disagree means fetching traits we then discard. We set NEITHER — `./tac.ts` leaves
   * `memoryConfig` at its schema defaults, where `traitGroups` is `.optional()` and unset, and no
   * `AdapterOptions` is passed below. So whatever the account returns is what renders, and the two
   * cannot disagree. If an operator ever needs to narrow this, add the fetch-side value and leave
   * the render side alone.
   *
   * Its OWN try/catch, not the outer one: the outer catch returns `null` and would throw away
   * observations we already have, where a profile failure should cost the profile section and
   * nothing else. TAC's own `fetchProfile` already swallows and returns `undefined`
   * (`packages/core/src/lib/tac.ts:630-637`), so in production this arm fires only if the handle
   * is not TAC — which is exactly what the test drives.
   *
   * No `AbortSignal`: `MemoryComposePort.compose` is not given one and `fetchProfile` takes none.
   * A barged-into turn therefore pays for a profile fetch nobody will hear.
   *
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * CACHED PER CONVERSATION, and that is a FIX rather than an optimisation.
   *
   * Voice runs `memoryMode: 'once'`, which caches TAC's Recall on `session.cachedMemory`
   * (`dist/index.js:3465-3477`) precisely so that a Conversation Orchestrator round-trip does not sit
   * in front of every spoken answer. The first version of this port then did an UNCACHED
   * `fetchProfile` on every turn, which partly defeated that. Measured on the first real call:
   * `profileMs` of 76, 623, 113 and 134 ms across four turns — every one of them in front of the
   * first token, and the 623 ms outlier alone is longer than a whole warm turn was at T13.
   *
   * So the profile is fetched at most once per conversation. Traits are set when Orchestrator resolves
   * the customer and effectively do not change mid-call, so re-reading them per turn bought nothing.
   *
   * A NEGATIVE RESULT IS CACHED TOO — `null` is a real answer here ("this profile has no traits", or
   * "the fetch failed"), and re-trying it every turn is exactly the case that hurt: a profile that
   * 404s would pay full latency on every turn of the call, forever.
   *
   * BOUNDED, with no lifecycle hook, and that is a decision rather than an omission. There is
   * deliberately no `forget(conversationId)` on `MemoryComposePort` for the channels to call on
   * disconnect: conversation ids are unique, so a stale entry can never be READ again — the only cost
   * of keeping one is the bytes — and adding the method would thread a new call through `types.ts`,
   * `voice.ts` and `tac.ts` to reclaim a few hundred small objects. The cap is what makes that safe,
   * so it is the cap, not a cleanup path, that must not be removed. Add the hook if a profile ever
   * grows large enough that 200 of them matter.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  const profileCache = new Map<string, Profile | null>();

  /**
   * Small on purpose. The only legitimate entries are conversations currently in flight, and voice
   * caps itself at `VOICE_MAX_CONVERSATIONS` anyway — this is the backstop for an entry whose
   * conversation ended by a route that never called `forgetProfile`, not a second conversation store.
   */
  const MAX_CACHED_PROFILES = 200;

  const remember = (conversationId: string, profile: Profile | null): void => {
    if (profileCache.size >= MAX_CACHED_PROFILES) {
      // Oldest-first, matching `end-call.ts`. Map iteration is insertion-ordered, and insertion order
      // is close enough to age here: an entry is written once, on the conversation's first turn.
      const oldest = profileCache.keys().next();
      if (oldest.done !== true) profileCache.delete(oldest.value);
    }
    profileCache.set(conversationId, profile);
  };

  const fetchTraits = async (
    profileId: string,
    conversationId: string,
  ): Promise<{ readonly profile: Profile | null; readonly ms: number }> => {
    // `has`, not a truthy check on `get`: a cached `null` is a hit, and treating it as a miss would
    // reinstate the per-turn fetch this cache exists to remove.
    if (profileCache.has(conversationId)) {
      return { profile: profileCache.get(conversationId) ?? null, ms: 0 };
    }
    const at = now();
    try {
      const fetched = await tac.fetchProfile(profileId);
      const traits = fetched?.traits;
      // Measured on this account today, and the shape is the surprise: traits are nested and keyed
      // by trait GROUP, not flat —
      // `{"id":"mem_profile_…","traits":{"Contact":{"phone":"+1919…"}}}`. TAC's renderer
      // JSON-stringifies a non-primitive value, so a group arrives as `- Contact: {"phone":"…"}`.
      // No traits at all means no section, so there is nothing to carry.
      const profile = traits === undefined ? null : { profileId, traits };
      remember(conversationId, profile);
      return { profile, ms: now() - at };
    } catch (err) {
      logger.warn(
        { err, conversationId, profileId },
        'memory: profile fetch failed — composing without traits',
      );
      // Cached deliberately. See the docblock: without this, a profile that fails pays full latency
      // in front of every spoken answer for the rest of the call.
      remember(conversationId, null);
      return { profile: null, ms: now() - at };
    }
  };

  return {
    async compose({ memory, conversationId, channel, profileId }) {
      const startedAt = now();

      try {
        /**
         * No payload means TAC was never asked to recall — `memoryMode: 'never'`, which is what
         * both channels ship with at T13, so this is the steady state rather than an edge case.
         * Deliberately silent and event-free: one log line and one obs event per turn saying
         * "nothing happened" would bury the turns where something did.
         *
         * `undefined` as well as `null`: voice spreads `userMemory` gated on its own existence
         * (`packages/core/src/channels/voice.ts:739`), so the key is ABSENT rather than nulled.
         *
         * Note this also means a `profileId` with memory off buys no profile section. That is the
         * right trade: a fetch on every turn is a Conversation Orchestrator round-trip in front of
         * the first spoken word, and nobody asked for it by turning memory off.
         */
        if (memory === null || memory === undefined) return null;

        const sections = RECALL_SECTIONS.safeParse(memory);
        if (!sections.success) {
          logger.debug(
            { conversationId, channel, err: sections.error },
            'memory: payload is not a recall response — ignored',
          );
          return null;
        }

        /**
         * **THE GUARD, half 2.** Constructed with `communications: []`, so the array the renderer
         * reads is empty by construction and `buildCommunicationsPrompt` returns `null` on it
         * (`packages/core/src/lib/tac-memory-response.ts:172-177`). No section, no `User:` lines.
         *
         * This also covers Flow A′'s error path without a special case. When TAC fell back to
         * `listCommunications`, the response it built wraps a `Communication[]`, and on that shape
         * its `observations` and `summaries` getters return `[]` — verified against the installed
         * bundle. So the parse above yields two empty arrays, this renders nothing, and `compose`
         * returns `null`: the current conversation cannot reach the prompt even though TAC put it
         * on the payload.
         *
         * Constructing rather than mutating is also the only safe move: `_communications` is
         * `private readonly` and set in the constructor, so there is nothing to zero in place
         * without a cast. And `new TACMemoryResponse` PARSES each communication it is given and
         * THROWS a ZodError on a bad one (measured: an author missing `address`/`channel` throws
         * from the constructor) — with an empty array there is nothing to parse, so our own
         * construction cannot be the thing that fails.
         */
        const recall = new TACMemoryResponse({ ...sections.data, communications: [] });

        const fetched = profileId === null ? null : await fetchTraits(profileId, conversationId);
        const profile = fetched?.profile ?? null;

        /**
         * The `ConversationSession` TAC's renderer wants. `conversationId` and `profileId` are
         * real; `metadata` is genuinely empty; `startedAt` is the one value we invent, because this
         * port does not own the session and has no access to when it began. Nothing reads it — see
         * `TAC_CHANNEL` — so stamping it from the clock says "when this object was built" rather
         * than making a claim about the conversation.
         *
         * Conditional spreads, not `undefined` values: `exactOptionalPropertyTypes` makes
         * `profile: undefined` a compile error, which is the repo's standing idiom (see `./tac.ts`).
         */
        const context: ConversationSession = {
          conversationId,
          channel: TAC_CHANNEL[channel],
          startedAt: new Date(now()),
          metadata: {},
          ...(profileId !== null && { profileId }),
          ...(profile !== null && { profile }),
        };

        /**
         * `MemoryPromptBuilder.build`, not `recall.buildMemoryPrompts()`.
         *
         * `buildMemoryPrompts()` returns the 0-3 memory sections as an array and nothing else: no
         * `# Customer Context` wrapper and no `## Customer Profile`. Choosing it would mean
         * hand-rolling both — and the profile section is not a heading, it is
         * `buildProfilePrompt`'s trait formatting (null filtering, primitives bare,
         * objects/arrays JSON-stringified, a bigint replacer). Reimplementing forty lines of vendor
         * formatting to avoid calling the vendor is the opposite of the standing convention, and it
         * means a TAC upgrade that improves the phrasing stops improving ours.
         *
         * `build` is a static on an all-static class (`packages/core/src/adapters/prompt-builder.ts:30`)
         * and returns one string, `''` when there is no data. Passing no `AdapterOptions` is
         * deliberate — see `fetchTraits` on why there is one filter and not two.
         *
         * Section order is TAC's and fixed: Customer Profile, Key Observations, Past Conversation
         * Summaries. Recent Message History would come fourth, and cannot.
         */
        const composed = MemoryPromptBuilder.build(recall, context);

        const traitGroups = Object.keys(profile?.traits ?? {}).length;
        bus.publish({
          kind: 'memory.recall',
          summary:
            composed === ''
              ? 'memory: recalled nothing to add'
              : `memory: ${sections.data.observations.length} observations, ${sections.data.summaries.length} summaries, ${traitGroups} trait groups → ${composed.length} chars`,
          channel,
          conversationId,
          durationMs: now() - startedAt,
          payload: {
            observations: sections.data.observations.length,
            summaries: sections.data.summaries.length,
            traitGroups,
            chars: composed.length,
            // `null` where no fetch was attempted, rather than 0 — 0 would read as a free fetch.
            profileMs: fetched === null ? null : fetched.ms,
          },
        });

        // `''` → `null`. See the header: the empty string is the failure this contract exists to
        // prevent, not a harmless equivalent.
        return composed === '' ? null : composed;
      } catch (err) {
        /**
         * The never-throws backstop. Anything the vendor or the payload can do — a getter that
         * throws mid-parse, a renderer that does not survive its own input — has the same correct
         * answer: log once, tell the console, and let the turn proceed with no memory.
         *
         * Reported on `memory.recall` rather than as an `error` event, following
         * `prompt/langfuse.ts`, which publishes its fallback reason on `prompt.fetch`. A memory
         * failure is a degraded step, not a failed turn, and `runTurn` owns `error`.
         */
        logger.error(
          { err, conversationId, channel },
          'memory: compose failed — the turn proceeds without it',
        );
        bus.publish({
          kind: 'memory.recall',
          summary: `memory: unavailable — ${errorMessage(err)}`,
          channel,
          conversationId,
          durationMs: now() - startedAt,
          payload: { failed: true, error: errorMessage(err), chars: 0 },
        });
        return null;
      }
    },
  };
}
