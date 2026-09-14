/**
 * TAC's built-in tools, adapted into the repo's own `ToolDef` shape.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THIS FILE IS WHY `ToolCtx` DOES NOT CARRY A TAC HANDLE.
 *
 * `adaptBuiltInTools` CLOSES OVER the live TAC handle and returns plain `ToolDef`s. Nothing in
 * `server/agent/` names anything from `twilio-agent-connect`, `tests/architecture.test.ts` needs no
 * new rule, and the only per-turn value that had to cross the seam is `ctx.profileId` — because
 * TAC takes the profile as a CONSTRUCTOR argument and we construct per call rather than at boot.
 * `server/agent/tools/registry.ts` records the same fact from the other side. Do not "simplify"
 * this by widening `ToolCtx`.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Two decisions shape everything below, and both were ratified in the T14 design (§5.3):
 *
 * 1. **Hand-written Zod mirrors, not `ai`'s `jsonSchema()` escape hatch.** `ToolDef.input` is a Zod
 *    schema; `TACTool.parameters` is raw JSON Schema. `jsonSchema()` is exported from ai@7.0.93 and
 *    IS accepted as `inputSchema`, but it loses three things: `toJsonSchema()`
 *    (`../agent/tools/registry.ts`) has no Zod object to project, so it and the T19 console
 *    inspector get nothing; `jsonSchema()` without an explicit `validate` performs NO argument
 *    validation, where the Zod path validates model output before `execute`; and TAC ships the
 *    identical Zod shape internally (`dist/index.js:633-636` carries
 *    `observationsLimit: z.number().int().min(0).max(100).default(20)` verbatim), so we would be
 *    mirroring a mirror. `defineTool` does four truthiness checks and adds no argument validation of
 *    its own — TAC hands model-supplied JSON straight to the implementation — so the mirrors below
 *    are the ONLY validation in the path.
 *
 *    A mirror is a FAITHFUL mirror: every field description here is TAC's own wording, kept that way
 *    by the drift tests in `tests/builtin-tools.test.ts`. All of our steering therefore lives in
 *    `ToolDef.description`, which is ours, and none of it in the field descriptions, which are not.
 *
 * 2. **The TAC tool is constructed LAZILY, inside `execute`.** Not at boot. A tool whose capability
 *    is absent never constructs at all (`resolve()` puts it in `unavailable`); the async knowledge
 *    factory's construction-time network call stays off the boot path, where `TAC.create()` already
 *    puts one thing that can fail for reasons outside the process; and a construction failure
 *    becomes a structured miss the model can speak about rather than a boot crash or dead air on a
 *    live call. Boot still gets a loud signal from `preflightDefaultPromptTools()`, which runs
 *    against the augmented catalog.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────────────────────────
 *
 * `send_message` — NOT adapted, and re-adding it breaks things. The model already speaks (voice) or
 * sends (SMS) its own answer, so the tool is redundant; TAC's `sendResponse` is declared to return a
 * promise but is not `async` in the bundle, so its closed-socket guard throws SYNCHRONOUSLY and a
 * bare `.catch()` misses it (`./voice.ts` documents the same trap); and the literal string
 * `'send_message'` is the UNKNOWN-TOOL FIXTURE in `tests/tools.test.ts`, so making it a real tool
 * turns two passing tests red for a reason that has nothing to do with what they assert.
 *
 * `handoff` — NOT here, and no longer deferred. It landed at T14b in `./handoff.ts`, built by
 * `./tac.ts` rather than by this factory, because it needs `getConversationSession` off the CHANNEL
 * (public on `BaseChannel`, absent from `TAC`) and this factory only receives `tac`.
 *
 * `createKnowledgeSearchToolAsync` — NOT used. It derives the tool's name and description by GETting
 * the knowledge base AT CONSTRUCTION, which under lazy construction would put a network call inside
 * a turn, and it would also let a Console rename of the base rename a tool a prompt names by string.
 * The synchronous factory takes both as required arguments; see `SEARCH_KNOWLEDGE_*` below.
 */
import {
  createKnowledgeSearchTool,
  createMemoryRetrievalTool,
  type KnowledgeClient,
  type MemoryClient,
} from 'twilio-agent-connect';
import { z } from 'zod';
import { TAC_TOOL_NAMES } from '../../shared/tac-tool-names.ts';
import type { ToolDef, ToolLogger } from '../agent/tools/registry.ts';

/**
 * The two TAC methods this file touches, and nothing else — the `VoiceSender` pattern from
 * `./voice.ts`. Typed with TAC's own client classes on purpose: `createMemoryRetrievalTool` and
 * `createKnowledgeSearchTool` demand them, so narrowing the CLIENTS as well would force a cast, and
 * a cast here would be a cast around the one contract this file exists to honour.
 *
 * Both are documented as "returns null in voice-only mode" — the clients only exist once a
 * Conversation Orchestrator configuration was fetched. `capabilities().memory` and `.knowledge`
 * already gate on orchestrated mode, so a null here means config and capability disagree, which is
 * why the miss branches below log it at `warn` rather than at `debug`.
 *
 * A test fake is two lines, and it can hold REAL clients: `new MemoryClient(config, storeId)` and
 * `new KnowledgeClient(config)` are pure constructors — measured, they make no network call — so the
 * drift tests exercise TAC's real construction path offline.
 */
export interface TacToolHost {
  getMemoryClient(): MemoryClient | null;
  getKnowledgeClient(): KnowledgeClient | null;
}

export interface BuiltInToolDeps {
  readonly tac: TacToolHost;
  /**
   * `AppConfig.knowledgeBaseId`. Taken as a value, not read from the environment, and NOT reachable
   * through `tac`: `TAC.create` reads exactly one field off the fetched Conversation Orchestrator
   * configuration — `memoryStoreId` — and never a knowledge base. Nullable because the type is, even
   * though `requires: 'knowledge'` means the tool only resolves when it is set.
   */
  readonly knowledgeBaseId: string | null;
}

/**
 * The structured-miss shape, copied from `../agent/tools/catalog.ts`: `found: false` plus a
 * `message` written FOR THE MODEL, saying what to say. Never a throw — a thrown tool error mid-turn
 * is dead air on a live call, and an agent saying "I can't confirm that policy, let me have someone
 * follow up" is a working demo.
 *
 * One discriminator across the whole catalog, deliberately. `found: false` reads a little wide for
 * "this tool cannot run right now" as opposed to "the thing you asked for does not exist", but a
 * second convention would make the model learn two. The `message` carries the real distinction, and
 * it is the part the model acts on.
 */
const miss = (message: string): { readonly found: false; readonly message: string } => ({
  found: false,
  message,
});

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// ------------------------------------------------------------------ retrieve_profile_memory

/**
 * Ours, not `BuiltInTools.RETRIEVE_MEMORY` — even though the two are the same string today, which
 * `tests/builtin-tools.test.ts` pins. Passing it explicitly as `options.name` decouples a prompt's
 * `config.tools` entry from a vendor enum: a TAC release that renamed the enum value would otherwise
 * silently rename this tool, and every prompt naming it would drop into `resolve()`'s `unknown`
 * bucket with one warning per turn and an agent that is quietly worse.
 */
const RETRIEVE_PROFILE_MEMORY_NAME = TAC_TOOL_NAMES[0];

/**
 * Ours to write. TAC's default — "Retrieve user memories including observations, summaries, and
 * conversation history" — describes the payload rather than the decision, and the decision is what a
 * model needs. Three things in here are load-bearing rather than decorative:
 *
 *  - **Extraction is post-conversation only.** Conversation Orchestrator derives observations and
 *    summaries after a conversation reaches INACTIVE or CLOSED; nothing this process does mid-call
 *    makes memory richer for the call it is on. Without that sentence a model will call this to
 *    "check" something the customer said thirty seconds ago and read the empty result as a
 *    contradiction.
 *  - **Always pass a query.** TAC's own note on `retrieveMemory` says sending a `conversationId`
 *    with no `query` makes Memory infer one from that conversation's history — an expensive
 *    server-side step. The mirror cannot make `query` required (TAC's schema says `required: []`,
 *    and the drift test holds us to it), so the instruction has to live here.
 *  - **An empty result is normal.** It is the expected state of a first-ever conversation, and the
 *    agent should carry on rather than announce that it has no record of the customer.
 *
 * Unlike `search_knowledge`, this string does NOT reach the model twice: TAC hard-codes the memory
 * tool's schema-level description to "Retrieve memories for the current user" and never echoes
 * `options.description` into `parameters`. Verified against the installed 2.2.0 bundle.
 */
const RETRIEVE_PROFILE_MEMORY_DESCRIPTION =
  'Recall what is already known about this customer from their EARLIER conversations: facts they ' +
  'stated before, and summaries of past contacts. Use it when the customer refers to something ' +
  'previously discussed, or before asking for a detail they may already have given. It reads a ' +
  'long-term profile that is written only after a conversation has ENDED, so it holds nothing from ' +
  'the conversation you are in now and cannot confirm something said a moment ago — everything from ' +
  'this conversation is already in front of you. Always pass a query naming what you are looking ' +
  'for; without one the service has to infer the topic from conversation history, which is slow. An ' +
  'empty result is normal for a first-time customer: carry on and ask.';

/**
 * The 7-field mirror of `packages/tools/src/built-in/memory.ts`'s schema, field descriptions and
 * bounds included, projected through `io: 'input'` so the four `.default()` fields stay OUT of
 * `required` and match TAC's own `required: []`.
 *
 * `z.int()` rather than `z.number().int()`: it projects to `type: 'integer'`, which is what TAC
 * writes. Measured — the explicit `.min(0).max(100)` replaces the safe-integer bounds `z.int()`
 * would otherwise emit, so nothing extra leaks into the projection.
 *
 * The object-level `.describe()` is TAC's literal schema description, not our tool description.
 */
const RetrieveProfileMemoryInput = z
  .object({
    query: z.string().describe('Optional semantic search query to filter memories').optional(),
    beginDate: z
      .string()
      .describe('Optional start date for filtering memories (ISO 8601 format)')
      .optional(),
    endDate: z
      .string()
      .describe('Optional end date for filtering memories (ISO 8601 format)')
      .optional(),
    observationsLimit: z
      .int()
      .min(0)
      .max(100)
      .default(20)
      .describe('Maximum number of observations to retrieve. Set to 0 to skip observations.'),
    summariesLimit: z
      .int()
      .min(0)
      .max(100)
      .default(5)
      .describe('Maximum number of summaries to retrieve. Set to 0 to skip summaries.'),
    communicationsLimit: z
      .int()
      .min(0)
      .max(100)
      .default(0)
      .describe('Maximum number of communications to retrieve. Set to 0 to skip communications.'),
    relevanceThreshold: z
      .number()
      .min(0)
      .max(1)
      .default(0)
      .describe('Minimum relevance score threshold for observations and summaries.'),
  })
  .describe('Retrieve memories for the current user');

const retrieveProfileMemoryTool = (tac: TacToolHost): ToolDef<typeof RetrieveProfileMemoryInput> => ({
  name: RETRIEVE_PROFILE_MEMORY_NAME,
  description: RETRIEVE_PROFILE_MEMORY_DESCRIPTION,
  input: RetrieveProfileMemoryInput,
  requires: 'memory',
  async execute(args, ctx) {
    const log = (level: keyof ToolLogger, fields: Record<string, unknown>, msg: string): void =>
      ctx.logger[level](
        { tool: RETRIEVE_PROFILE_MEMORY_NAME, conversationId: ctx.conversationId, ...fields },
        msg,
      );

    /**
     * OUR check, ahead of TAC's. `createMemoryRetrievalTool`'s implementation throws
     * `No profile ID available for memory retrieval` on a falsy profile id, and `null` is a real
     * value on `ToolCtx` — the bench has no Orchestrator profile at all, and voice had none reaching
     * the handler before T14.5. Catching our own throw would work; not causing it says why.
     *
     * `debug`, not `warn`: an absent profile is the EXPECTED state of a half-configured demo, which
     * is the distinction `../agent/tools/resolve.ts` draws between the two levels.
     */
    if (ctx.profileId === null) {
      log('debug', {}, 'retrieve_profile_memory: no profile id on this turn, so there is nothing to recall');
      return miss(
        'There is no customer profile for this conversation, so nothing is remembered from earlier ' +
          'contacts. Answer from what the customer tells you now, and do not mention memory.',
      );
    }

    const client = tac.getMemoryClient();
    if (client === null) {
      // `caps.memory` is `orchestrated`, and the client exists whenever orchestrated mode does — so
      // reaching this means the capability that let the tool resolve and the handle disagree.
      log('warn', {}, 'retrieve_profile_memory: caps.memory resolved this tool but TAC has no memory client');
      return miss(
        'Long-term memory is not reachable on this deployment, so nothing is remembered from ' +
          'earlier contacts. Answer from what the customer tells you now, and do not mention memory.',
      );
    }

    try {
      /**
       * `conversationId` is passed ONLY when the model supplied a query, which is TAC's own
       * instruction on `retrieveMemory`: *"Sending one without a `query` makes Memory infer one from
       * that conversation's history — an expensive server-side step — so leave it unset when there
       * is no per-turn topic."* Nothing is lost by omitting it here: observations and summaries are
       * profile-scoped, and `communicationsLimit` defaults to 0, so the id only ever affects the
       * inference. `meta.queryTime` in the debug line below is how that cost is watched.
       */
      const tool = createMemoryRetrievalTool(
        client,
        ctx.profileId,
        args.query === undefined ? undefined : ctx.conversationId,
        { name: RETRIEVE_PROFILE_MEMORY_NAME, description: RETRIEVE_PROFILE_MEMORY_DESCRIPTION },
      );

      /**
       * Built key by key rather than forwarded wholesale. TAC's implementation filters `undefined`
       * out itself, so the conditional spreads are a TYPE requirement, not a runtime one:
       * `exactOptionalPropertyTypes` will not assign Zod's `query?: string | undefined` to TAC's
       * `query?: string`. Being explicit also makes what crosses to the vendor greppable.
       */
      const response = await tool.implementation({
        ...(args.query !== undefined && { query: args.query }),
        ...(args.beginDate !== undefined && { beginDate: args.beginDate }),
        ...(args.endDate !== undefined && { endDate: args.endDate }),
        observationsLimit: args.observationsLimit,
        summariesLimit: args.summariesLimit,
        communicationsLimit: args.communicationsLimit,
        relevanceThreshold: args.relevanceThreshold,
      });

      const { observations, summaries, communications } = response;
      log(
        'debug',
        {
          observations: observations.length,
          summaries: summaries.length,
          communications: communications.length,
          // TAC's server-side timing, kept out of the model's view and in the operator's. This is
          // the number that moves when the model omits `query`.
          queryTimeMs: response.meta?.queryTime ?? null,
          scopedToConversation: args.query !== undefined,
        },
        'retrieve_profile_memory: recall returned',
      );

      if (observations.length === 0 && summaries.length === 0 && communications.length === 0) {
        // Reported as a miss rather than as three empty arrays, because this is the state a demo
        // actually lands in: extraction runs only after a conversation closes, so a first-ever
        // conversation has nothing to recall and the agent must not treat that as a finding.
        return miss(
          'Nothing has been remembered about this customer yet, which is normal on a first ' +
            'conversation. Answer from what the customer tells you now and ask for anything you need.',
        );
      }

      /**
       * PROJECTED, not passed through. Observations and summaries carry `id`, `createdAt`,
       * `occurredAt`, `conversationIds` and `source` beside `content`; none of that is actionable for
       * the model, and on voice every token is in front of the first spoken word. Add `occurredAt`
       * back if a demo ever needs "you mentioned this in August" — and say so here when you do.
       *
       * Communications are projected for a second reason: their `author` and `recipients` carry an
       * `address`, i.e. a phone number. `../obs/pii.ts` scrubs LOG lines, not tool results, so
       * dropping it is the only thing that keeps a caller's number out of the model's context. The
       * path is off by default anyway — `communicationsLimit` defaults to 0, matching TAC — and
       * raising it re-states this conversation in a second format beside `../agent/history.ts`,
       * which is the exact duplication `./tac.ts`'s `memoryMode` comment exists to avoid.
       */
      return {
        found: true,
        observations: observations.map((o) => o.content),
        summaries: summaries.map((s) => s.content),
        communications: communications.map((c) => ({
          author: c.author.name,
          channel: c.author.channel,
          text: c.content.text ?? null,
          at: c.createdAt,
        })),
      };
    } catch (err) {
      // Construction and the Recall round-trip share one catch: both fail for reasons outside the
      // process, and the model's next move is identical either way. Logged once, here, at the
      // boundary of the vendor call — never re-thrown.
      log('warn', { error: errorMessage(err) }, 'retrieve_profile_memory: recall failed');
      return miss(
        'Long-term memory could not be read just now. Answer from what the customer tells you now, ' +
          'and do not mention the failure.',
      );
    }
  },
});

// ------------------------------------------------------------------ search_knowledge

/**
 * `search_knowledge`. Ours to choose — `createKnowledgeSearchTool` takes `name` as a required
 * argument and never consults `BuiltInTools.SEARCH_KNOWLEDGE` — and chosen to be the same string
 * anyway, which `tests/builtin-tools.test.ts` pins so the coincidence stays deliberate.
 *
 * A more pointed name (`search_support_policies`) would steer the model harder than this one does.
 * It loses on two counts: `search_knowledge` is already the name in the T14 plan, the T14 design,
 * `docs/scaffold-next-steps.html`'s operator table and two test files, so renaming makes four
 * documents wrong at once; and the differentiating work belongs in the description regardless — see
 * below for why no other mechanism is available.
 */
const SEARCH_KNOWLEDGE_NAME = TAC_TOOL_NAMES[1];

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THIS STRING IS THE ONLY THING KEEPING KNOWLEDGE SEARCH OUT OF `lookup_order`'s TERRITORY.
 *
 * Measured 2026-09-14 against the real, populated base (`scripts/verify-knowledge.ts` carries the
 * full account): `score` is normalised PER QUERY, so it is not comparable across queries. An
 * in-scope question — "What is your return window?" — scored 1.0 / 0.54 / 0.53. An out-of-scope one
 * — "Where is my order A4721?" — scored 0.816 / 0.468 / 0.38. The out-of-scope query's TOP hit
 * outscores the in-scope query's own second hit. No threshold can separate "the base does not know
 * this" from "it does", and semantic search therefore always returns something, confidently.
 *
 * That leaves exactly two mechanisms. Content curation, done: `scripts/knowledge-articles.ts`
 * deliberately excludes order status and store hours, and two articles point BACK to order lookup.
 * And this description. There is no third.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * So it is written as prompt text (`../agent/tools/registry.ts`: "write it for the reader who has to
 * choose between this tool and the one next to it"), and it does three jobs: it enumerates what the
 * five articles actually cover, so the model can recognise a policy question; it names the two tools
 * that own the questions this one must not answer, phrased so it still reads correctly on a prompt
 * that offers neither; and it tells the model that a returned passage is not evidence the library
 * covers the topic, which is the direct consequence of the measurement above and the one instruction
 * no schema or threshold can express.
 *
 * NOTE it reaches the model TWICE. `createKnowledgeSearchTool` echoes `config.description` into
 * `parameters.description`, so the Zod mirror carries the same string to keep the drift test an
 * honest deep-equal. Measured at 917 characters, so the duplication costs roughly 230 tokens on a
 * turn where the tool is offered. Accepted: the alternative is a second, terser string handed to TAC,
 * which would make the drift test compare two of OUR strings rather than TAC's contract — and the
 * repetition lands where the model is filling in the argument, which is where the choice is made.
 */
const SEARCH_KNOWLEDGE_DESCRIPTION =
  "Search Northwind Traders' written support policies and answer from what they say. This is the " +
  'only source for policy questions: returns and exchanges (the return window, what cannot be ' +
  'returned, refund timing), published shipping methods with their costs and transit times, ' +
  'warranty length and coverage per product, claims for items that arrived damaged, missing or ' +
  'wrong, and the price match guarantee. Do NOT use it for anything about one specific order — a ' +
  'status, which parcel an item is in, or a delivery estimate all come from looking that order up ' +
  'by its order number (lookup_order) — and do NOT use it for store opening hours ' +
  '(get_store_hours). It matches on meaning, so it always returns its closest passages even when ' +
  'the policy library does not cover the question at all: answer from them only if they genuinely ' +
  'answer it, and otherwise say the policy is not documented and offer to have someone follow up.';

/**
 * 3, not TAC's default of 5.
 *
 * Measured: all five probe queries in `scripts/verify-knowledge.ts` retrieve their intended article
 * within the top 3, and rank 1 is explicitly NOT guaranteed — a query naming a product pulls
 * `warranty-terms` up, because that is the article listing every product by name. So 3 is the
 * smallest window the measurement supports, and on voice each additional chunk of article prose is
 * latency in front of the first spoken word. Raise it if a demo shows the answer sitting at rank 4;
 * that is a content problem first.
 */
const KNOWLEDGE_TOP_K = 3;

/**
 * The 1-field mirror of `packages/tools/src/built-in/knowledge.ts`. See the memory mirror above.
 *
 * Deliberately NOT `.describe(SEARCH_KNOWLEDGE_DESCRIPTION)`, and the reason is worth stating because
 * the drift test makes the opposite look required. TAC echoes `config.description` back onto
 * `TACTool.parameters.description`, so an exact deep-equal against it appears to demand the same string
 * here — but that comparison is CIRCULAR: for this tool the vendor's description IS our own string,
 * handed in one line earlier, so matching it proves nothing about TAC.
 *
 * And it is not free. Measured on zod 4.5.4: a top-level `.describe()` emits a `description` key into
 * the JSON Schema the AI SDK sends the model, which already receives the same prose as
 * `ToolDef.description`. That is ~900 characters of identical text twice per turn, on a channel where
 * prompt size is latency in front of the first spoken word.
 *
 * The drift test therefore normalises the TOP-LEVEL `description` away on both sides. Per-FIELD
 * descriptions are still compared — they are nested under `properties`, they genuinely come from TAC,
 * and they are what the model reads to fill an argument.
 */
const SearchKnowledgeInput = z.object({
  query: z.string().describe('The search query to find relevant knowledge'),
});

const searchKnowledgeTool = (
  tac: TacToolHost,
  knowledgeBaseId: string | null,
): ToolDef<typeof SearchKnowledgeInput> => ({
  name: SEARCH_KNOWLEDGE_NAME,
  description: SEARCH_KNOWLEDGE_DESCRIPTION,
  input: SearchKnowledgeInput,
  requires: 'knowledge',
  async execute({ query }, ctx) {
    const log = (level: keyof ToolLogger, fields: Record<string, unknown>, msg: string): void =>
      ctx.logger[level](
        { tool: SEARCH_KNOWLEDGE_NAME, conversationId: ctx.conversationId, ...fields },
        msg,
      );

    const client = tac.getKnowledgeClient();
    if (knowledgeBaseId === null || client === null) {
      // `caps.knowledge` is `orchestrated && knowledgeBaseId !== null`, and `KnowledgeClient` is
      // built unconditionally in orchestrated mode — so the capability that let this tool resolve
      // already asserted both of these. Reaching here means it and the values disagree, hence `warn`.
      // Both flags ride on the line so the operator sees WHICH half is missing.
      log(
        'warn',
        { hasBaseId: knowledgeBaseId !== null, hasClient: client !== null },
        'search_knowledge: caps.knowledge resolved this tool but the base id or the client is missing',
      );
      return miss(
        'The written policy library is not reachable on this deployment. Do not guess at a policy: ' +
          'say you cannot confirm it and offer to have someone follow up.',
      );
    }

    try {
      const tool = createKnowledgeSearchTool(client, knowledgeBaseId, {
        name: SEARCH_KNOWLEDGE_NAME,
        description: SEARCH_KNOWLEDGE_DESCRIPTION,
        topK: KNOWLEDGE_TOP_K,
      });
      const chunks = await tool.implementation({ query });

      // Scores go to the operator and never to the model — see SEARCH_KNOWLEDGE_DESCRIPTION on why
      // they cannot be reasoned about. They are still the fastest way to see that a query hit the
      // base at all.
      log(
        'debug',
        { query, chunks: chunks.length, scores: chunks.map((c) => c.score ?? null) },
        'search_knowledge: search returned',
      );

      if (chunks.length === 0) {
        // A populated base always returns its closest passages, so zero chunks is not "no such
        // policy" — it is an empty or still-indexing base, which is a configuration state.
        log('warn', { query }, 'search_knowledge: the base returned no chunks at all');
        return miss(
          'The policy library returned nothing at all, which means it is empty or still indexing ' +
            'rather than that no policy exists. Do not guess: say you cannot confirm the policy and ' +
            'offer to have someone follow up.',
        );
      }

      /**
       * The passages, and only the passages.
       *
       * NO CITATION FIELDS, and that is not an omission. The Search API does return `documentTitle`
       * and `documentUrl`, which would let the model cite an article by name — but TAC's
       * `KnowledgeChunkResultSchema` is a stripping object over `content` / `knowledgeId` /
       * `createdAt` / `score`, so they are already gone by the time `searchKnowledgeBase` resolves.
       * Recovering them means bypassing TAC with our own HTTP call, which this repo does not do. And
       * measured (`scripts/verify-knowledge.ts`): for a `Text` source both are `null` anyway, so the
       * bypass would buy nothing here. Revisit only if the articles ever move to `File` sources.
       *
       * `knowledgeId` and `createdAt` are dropped as noise: an opaque `know_…` id is not something a
       * model can quote to a customer.
       */
      return { found: true, query, passages: chunks.map((c) => c.content) };
    } catch (err) {
      log('warn', { query, error: errorMessage(err) }, 'search_knowledge: search failed');
      return miss(
        'The policy search failed. Do not guess at a policy: say you cannot confirm it and offer to ' +
          'have someone follow up.',
      );
    }
  },
});

// ------------------------------------------------------------------ the factory

/**
 * The adapted built-ins, in a fixed order. Handed to `createToolCatalog` alongside `SHIPPED_TOOLS`
 * at boot (T14.6) so a prompt can name either by string.
 *
 * Both set `requires`, so a process without orchestrated mode or without a knowledge base id offers
 * neither — `resolve()` reports them as `unavailable` with one debug line and the turn proceeds. That
 * is what keeps the Twilio-free bench on exactly the three shipped tools.
 */
export function adaptBuiltInTools(deps: BuiltInToolDeps): readonly ToolDef[] {
  return [
    retrieveProfileMemoryTool(deps.tac),
    searchKnowledgeTool(deps.tac, deps.knowledgeBaseId),
  ];
}
