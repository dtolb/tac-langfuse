import { test, expect } from 'vitest';
import { z } from 'zod';
import {
  BuiltInTools,
  createKnowledgeSearchTool,
  createMemoryRetrievalTool,
  EMPTY_MEMORY_RESPONSE,
  KnowledgeClient,
  MemoryClient,
  TACConfig,
  type KnowledgeChunkResult,
  type MemoryRetrievalRequest,
  type MemoryRetrievalResponse,
} from 'twilio-agent-connect';
import { adaptBuiltInTools, type TacToolHost } from '../server/twilio/builtin-tools.ts';
import { createToolCatalog, SHIPPED_TOOLS } from '../server/agent/tools/catalog.ts';
import { resolve } from '../server/agent/tools/resolve.ts';
import {
  isValidToolName,
  type ToolCtx,
  type ToolDef,
  type ToolLogger,
} from '../server/agent/tools/registry.ts';
import type { Capabilities } from '../server/config.ts';
import { createObsBus } from '../server/obs/bus.ts';

/**
 * The TAC built-in adapters. Two claims dominate this file.
 *
 * **The drift tests are the point.** Our Zod mirrors and TAC's raw JSON Schema are two spellings of
 * one contract, and `defineTool` performs NO argument validation — TAC hands model-supplied JSON
 * straight to the implementation — so the mirror is the only thing between the model and the vendor.
 * If a TAC upgrade renames a field or moves a bound, the honest failure is a red build here, not a
 * silently mis-validated argument on a live call.
 *
 * **Every failure path returns, none throws.** A thrown tool error mid-turn is dead air on a phone
 * call, so a null profile, a missing client, an empty result and a failed round-trip all have to come
 * back as a structured miss the model can speak about. Each of those is a test below.
 *
 * ── Why this file subclasses two vendor classes, which is otherwise not the house style ──────────
 *
 * `createMemoryRetrievalTool` and `createKnowledgeSearchTool` demand a real `MemoryClient` /
 * `KnowledgeClient`, so `TacToolHost` is typed with those classes and a structural fake would need a
 * cast — a cast around the one contract this suite exists to check. Extending the real class and
 * overriding the ONE method the tool calls is cast-free, and it keeps TAC's real construction and
 * request-building code inside the tested path: `RecordingMemoryClient` below sees the request TAC
 * built, not the arguments we handed it.
 *
 * Both constructors are pure — measured, no network — so `DUMMY_CONFIG` with obviously-fake
 * credentials is enough and nothing here can reach Twilio. That is also what makes the drift tests
 * runnable offline.
 */

/** Shaped to pass `TACConfigSchema`, and obviously fake so nobody mistakes it for a credential. */
const DUMMY_CONFIG = new TACConfig({
  accountSid: `AC${'0'.repeat(32)}`,
  authToken: '0'.repeat(32),
  apiKey: `SK${'0'.repeat(32)}`,
  apiSecret: '0'.repeat(32),
  phoneNumber: '+15550000000',
  // `undefined` means "TAC's default" — the same three keys `server/twilio/tac.ts` spells out.
  voiceWebsocketPath: undefined,
  voiceActionPath: undefined,
  voiceCallEventPath: undefined,
});

const TEST_KB_ID = 'know_knowledgebase_test';
const TEST_CONVERSATION_ID = 'CH_test_conversation';
const TEST_PROFILE_ID = 'mem_profile_test';

// ------------------------------------------------------------------ fakes, injected not mocked

class RecordingMemoryClient extends MemoryClient {
  /** The request TAC BUILT, so a test can assert on what actually reached the vendor's client. */
  readonly requests: Partial<MemoryRetrievalRequest>[] = [];
  readonly profileIds: string[] = [];
  answer: () => Promise<MemoryRetrievalResponse> = async () => EMPTY_MEMORY_RESPONSE;

  constructor() {
    super(DUMMY_CONFIG, 'mem_store_test');
  }

  override async retrieveMemories(
    profileId: string,
    request?: Partial<MemoryRetrievalRequest>,
  ): Promise<MemoryRetrievalResponse> {
    this.profileIds.push(profileId);
    this.requests.push(request ?? {});
    return this.answer();
  }
}

class RecordingKnowledgeClient extends KnowledgeClient {
  readonly calls: { baseId: string; query: string; topK: number | undefined }[] = [];
  answer: () => Promise<KnowledgeChunkResult[]> = async () => [];

  constructor() {
    super(DUMMY_CONFIG);
  }

  override async searchKnowledgeBase(
    baseId: string,
    query: string,
    topK?: number,
  ): Promise<KnowledgeChunkResult[]> {
    this.calls.push({ baseId, query, topK });
    return this.answer();
  }
}

interface Line {
  readonly level: 'debug' | 'warn' | 'error';
  readonly fields: Record<string, unknown>;
  readonly msg: string;
}

const collecting = (): ToolLogger & { readonly lines: readonly Line[] } => {
  const lines: Line[] = [];
  return {
    lines,
    debug: (fields, msg) => void lines.push({ level: 'debug', fields, msg }),
    warn: (fields, msg) => void lines.push({ level: 'warn', fields, msg }),
    error: (fields, msg) => void lines.push({ level: 'error', fields, msg }),
  };
};

const silent: ToolLogger = { debug: () => {}, warn: () => {}, error: () => {} };

const ctx = (logger: ToolLogger = silent, profileId: string | null = TEST_PROFILE_ID): ToolCtx => ({
  conversationId: TEST_CONVERSATION_ID,
  logger,
  profileId,
});

/** Everything off, as `tests/tools.test.ts` has it — the bare-laptop baseline. */
const caps = (over: Partial<Capabilities> = {}): Capabilities => ({
  llm: true,
  prompts: true,
  voice: false,
  sms: false,
  memory: false,
  handoff: false,
  knowledge: false,
  ...over,
});

/**
 * A host whose getters throw. Handed to `adaptBuiltInTools` it proves construction is LAZY: if the
 * factory touched TAC at all, building the tools would throw here instead of at call time.
 */
const explodingHost: TacToolHost = {
  getMemoryClient: () => {
    throw new Error('boot must not construct the memory tool');
  },
  getKnowledgeClient: () => {
    throw new Error('boot must not construct the knowledge tool');
  },
};

const adapt = (
  over: {
    memory?: MemoryClient | null;
    knowledge?: KnowledgeClient | null;
    knowledgeBaseId?: string | null;
  } = {},
): readonly ToolDef[] =>
  adaptBuiltInTools({
    tac: {
      getMemoryClient: () => over.memory ?? null,
      getKnowledgeClient: () => over.knowledge ?? null,
    },
    knowledgeBaseId: over.knowledgeBaseId === undefined ? TEST_KB_ID : over.knowledgeBaseId,
  });

const named = (tools: readonly ToolDef[], name: string): ToolDef => {
  const found = tools.find((t) => t.name === name);
  if (found === undefined) throw new Error(`the factory returned no tool named ${name}`);
  return found;
};

const memoryTool = (client: MemoryClient | null): ToolDef =>
  named(adapt({ memory: client }), 'retrieve_profile_memory');

const knowledgeTool = (
  client: KnowledgeClient | null,
  knowledgeBaseId: string | null = TEST_KB_ID,
): ToolDef => named(adapt({ knowledge: client, knowledgeBaseId }), 'search_knowledge');

type Miss = { found: boolean; message?: string };

// ------------------------------------------------------------------ schema drift

/**
 * Three normalisations, each measured against zod 4.5.4 rather than assumed, and all applied to BOTH
 * sides so the comparison stays symmetric:
 *
 *  - Zod stamps `$schema: 'https://json-schema.org/draft/2020-12/schema'` on the document. TAC writes
 *    no such key.
 *  - Zod OMITS `required` entirely when nothing is required; TAC writes `required: []`. Same claim,
 *    two spellings — and note this only agrees because `io: 'input'` keeps the four `.default()`
 *    fields out of `required`. Under Zod's default `io: 'output'` the memory mirror would demand all
 *    four and the drift test would (correctly) fail.
 *  - The TOP-LEVEL `description`. This one is not cosmetic, so read the reason: for
 *    `search_knowledge`, TAC echoes the `config.description` WE handed it straight back onto
 *    `parameters.description`, so comparing it is circular — it asserts our own string equals itself
 *    and says nothing about the vendor. Matching it would also mean putting `.describe(...)` on the
 *    Zod object, which emits a `description` into the schema the AI SDK sends the model, on top of the
 *    identical `ToolDef.description` it already sends: ~900 characters twice per turn, which on voice
 *    is latency in front of the first spoken word. `server/twilio/builtin-tools.ts` carries the same
 *    note at the mirror.
 *
 * What is deliberately still compared: every PER-FIELD description. Those are nested under
 * `properties`, they genuinely originate in TAC, and they are what the model reads in order to fill an
 * argument — so a TAC upgrade that rewords one must still fail here. Mutating the `query` field's
 * description was measured to fail this test after this normalisation was added.
 */
const normalise = (schema: unknown): Record<string, unknown> => {
  const copy = { ...(schema as Record<string, unknown>) };
  delete copy.$schema;
  delete copy.description;
  return { required: [], ...copy };
};

const projected = (def: ToolDef): Record<string, unknown> =>
  normalise(z.toJSONSchema(def.input, { io: 'input' }));

test("the retrieve_profile_memory mirror still matches TAC's own JSON Schema", () => {
  // Constructed for real, offline. `parameters` does not depend on the client or on `options`, so a
  // recording client with fake credentials is enough to read the vendor's schema out of the bundle.
  const tacTool = createMemoryRetrievalTool(new RecordingMemoryClient(), TEST_PROFILE_ID);
  expect(projected(memoryTool(null))).toEqual(normalise(tacTool.parameters));
});

test("the search_knowledge mirror still matches TAC's own JSON Schema", () => {
  const def = knowledgeTool(null);
  // `name` and `description` are OURS — TAC never consults its own `SEARCH_KNOWLEDGE` enum — and TAC
  // echoes `config.description` into `parameters.description`. Reading both off the shipped ToolDef
  // is what makes this deep-equal cover that echo as well as the argument contract.
  const tacTool = createKnowledgeSearchTool(new RecordingKnowledgeClient(), TEST_KB_ID, {
    name: def.name,
    description: def.description,
  });
  expect(projected(def)).toEqual(normalise(tacTool.parameters));
});

test('the memory mirror keeps every defaulted field optional and bounded', () => {
  // The half of the contract a deep-equal on the schema cannot show: that the mirror VALIDATES.
  // `defineTool` adds none of its own, so this is the only gate in front of TAC's implementation.
  const input = memoryTool(null).input;
  expect(input.safeParse({}).success).toBe(true);
  expect(input.safeParse({ observationsLimit: 101 }).success).toBe(false);
  expect(input.safeParse({ observationsLimit: 1.5 }).success).toBe(false);
  expect(input.safeParse({ relevanceThreshold: 1.5 }).success).toBe(false);
  expect(input.safeParse({ query: 42 }).success).toBe(false);
});

test('the knowledge mirror requires a query', () => {
  const input = knowledgeTool(null).input;
  expect(input.safeParse({}).success).toBe(false);
  expect(input.safeParse({ query: 'what is your return window' }).success).toBe(true);
});

// ------------------------------------------------------------------ what the factory produces

test('the factory produces exactly the two adapted tools, each gated on its capability', () => {
  const tools = adapt();
  expect(tools.map((t) => t.name)).toEqual(['retrieve_profile_memory', 'search_knowledge']);
  expect(tools.map((t) => t.requires)).toEqual(['memory', 'knowledge']);
});

test('the two deliberate omissions stay omitted', () => {
  // `send_message` is redundant with streaming, throws SYNCHRONOUSLY on a closed socket, and is the
  // UNKNOWN-TOOL FIXTURE in tests/tools.test.ts — adding it for real turns two passing tests red for
  // a reason unrelated to what they assert. `handoff` is T14b, blocked on the Studio flow SID.
  const names = adapt().map((t) => t.name);
  expect(names).not.toContain('send_message');
  expect(names).not.toContain('handoff');
});

test("both names are TAC's own strings, and both are legal tool names", () => {
  // The names are ours to choose — `createKnowledgeSearchTool` takes `name` as a required argument
  // and `createMemoryRetrievalTool` takes it as an option — and we chose TAC's. This pins that
  // coincidence: a TAC release that renamed either enum value would otherwise leave a reader unable
  // to tell a deliberate match from a stale copy.
  expect(BuiltInTools.RETRIEVE_MEMORY).toBe('retrieve_profile_memory');
  expect(BuiltInTools.SEARCH_KNOWLEDGE).toBe('search_knowledge');
  // A name outside TOOL_NAME_RE is an opaque 400 from OpenAI in the middle of a turn.
  expect(adapt().every((t) => isValidToolName(t.name))).toBe(true);
});

test('nothing is constructed at boot, so a broken TAC handle cannot stop the process', () => {
  // The design decision most worth preserving. If either adapter reached for a client eagerly, this
  // would throw instead of returning two tools.
  expect(adaptBuiltInTools({ tac: explodingHost, knowledgeBaseId: null }).map((t) => t.name)).toEqual([
    'retrieve_profile_memory',
    'search_knowledge',
  ]);
});

test('an unsatisfied capability lands both tools in unavailable, and neither constructs', () => {
  const tools = adaptBuiltInTools({ tac: explodingHost, knowledgeBaseId: null });
  const r = resolve(['retrieve_profile_memory', 'search_knowledge'], {
    capabilities: caps({ memory: false, knowledge: false }),
    catalog: createToolCatalog(tools),
    logger: silent,
    bus: createObsBus(),
  });

  expect(r.unavailable).toEqual(['retrieve_profile_memory', 'search_knowledge']);
  expect(r.resolved).toEqual([]);
  // And nothing threw, which is the "never constructs" half: `explodingHost` would have made it.
  expect(r.unknown).toEqual([]);
});

test('the adapted tools fold into the shipped catalog without a name collision', () => {
  // What T14.6 does at boot. `createToolCatalog` throws on a duplicate, so this is the check that
  // a built-in name never shadows a demo tool.
  const catalog = createToolCatalog([...SHIPPED_TOOLS, ...adapt()]);
  expect(catalog.names).toEqual([
    'lookup_order',
    'get_store_hours',
    'end_call',
    'retrieve_profile_memory',
    'search_knowledge',
  ]);
});

// ------------------------------------------------------------------ retrieve_profile_memory

test('a null profileId is a structured miss, and TAC is never given the chance to throw', async () => {
  // `createMemoryRetrievalTool`'s implementation throws `No profile ID available for memory
  // retrieval` on a falsy profile, and `null` is a REAL value on ToolCtx — the bench has no
  // Orchestrator profile at all. Catching our own throw would work; not causing it is why the client
  // below records nothing.
  const client = new RecordingMemoryClient();
  const logger = collecting();
  const r = (await memoryTool(client).execute({}, ctx(logger, null))) as Miss;

  expect(r.found).toBe(false);
  expect(r.message).toContain('no customer profile');
  expect(client.profileIds).toEqual([]);
  // An absent profile is the expected state of a half-configured demo, so `debug`, not `warn` —
  // the distinction server/agent/tools/resolve.ts draws.
  expect(logger.lines.map((l) => l.level)).toEqual(['debug']);
});

test('a missing memory client is a structured miss and one warning', async () => {
  // caps.memory is `orchestrated` and the client exists whenever orchestrated mode does, so getting
  // here means the capability that resolved this tool and the handle disagree. That is a real
  // problem with the process, hence warn.
  const logger = collecting();
  const r = (await memoryTool(null).execute({}, ctx(logger))) as Miss;

  expect(r.found).toBe(false);
  expect(logger.lines.map((l) => l.level)).toEqual(['warn']);
});

test('recall returns observations and summaries as plain text', async () => {
  const client = new RecordingMemoryClient();
  client.answer = async () => ({
    observations: [
      {
        id: 'obs_1',
        content: 'Prefers email over a phone call.',
        createdAt: '2026-08-02T10:00:00Z',
      },
    ],
    summaries: [
      {
        id: 'sum_1',
        content: 'Asked about a creased desk mat in August.',
        createdAt: '2026-08-02T11:00:00Z',
      },
    ],
    communications: [],
  });

  const r = (await memoryTool(client).execute(
    { observationsLimit: 20, summariesLimit: 5, communicationsLimit: 0, relevanceThreshold: 0 },
    ctx(),
  )) as { found: boolean; observations: string[]; summaries: string[] };

  expect(r.found).toBe(true);
  // Projected, not passed through: the ids, timestamps and `source` fields are noise the model
  // cannot act on, and on voice every token sits in front of the first spoken word.
  expect(r.observations).toEqual(['Prefers email over a phone call.']);
  expect(r.summaries).toEqual(['Asked about a creased desk mat in August.']);
});

test("a recalled communication does not carry the caller's phone number", async () => {
  // The one assertion in this file that is about safety rather than behaviour. TAC's communication
  // author carries an `address`, i.e. a phone number, and server/obs/pii.ts scrubs LOG lines — not
  // tool results. Projecting the author down to a name is the only thing keeping it out of the
  // model's context, so the check is on the whole serialised result rather than on one field.
  const address = '+13175550142';
  const recipientAddress = '+15550000000';
  const client = new RecordingMemoryClient();
  client.answer = async () => ({
    observations: [],
    summaries: [],
    communications: [
      {
        id: 'comm_1',
        author: { id: 'part_1', name: 'Ada Lovelace', address, channel: 'SMS' },
        content: { text: 'my mat arrived creased' },
        recipients: [{ id: 'part_2', name: 'Northwind', address: recipientAddress, channel: 'SMS' }],
        createdAt: '2026-08-02T11:00:00Z',
      },
    ],
  });

  const r = await memoryTool(client).execute(
    { observationsLimit: 20, summariesLimit: 5, communicationsLimit: 5, relevanceThreshold: 0 },
    ctx(),
  );

  expect(JSON.stringify(r)).not.toContain(address);
  // `recipients` is dropped wholesale for the same reason — every entry carries an address too.
  expect(JSON.stringify(r)).not.toContain(recipientAddress);
  expect(JSON.stringify(r)).toContain('Ada Lovelace');
});

test('an empty recall is reported as a miss the model can speak to, not as three empty arrays', async () => {
  // The state a demo actually lands in. Extraction runs only after a conversation closes, so a
  // first-ever conversation has nothing to recall — and the agent must not read that as a finding.
  const client = new RecordingMemoryClient();
  const logger = collecting();
  const r = (await memoryTool(client).execute({}, ctx(logger))) as Miss;

  expect(r.found).toBe(false);
  expect(r.message).toContain('first');
  // Nothing is wrong, so nothing is warned about: one debug line reporting the counts.
  expect(logger.lines.map((l) => l.level)).toEqual(['debug']);
});

test('the mirror defaults are what reach TAC when the model sends no arguments', async () => {
  // Proves the `.default()` values are live rather than documentation: `communicationsLimit: 0` is
  // what keeps this conversation from being re-stated beside server/agent/history.ts.
  const client = new RecordingMemoryClient();
  const def = memoryTool(client);
  await def.execute(def.input.parse({}), ctx());

  expect(client.requests[0]).toMatchObject({
    observationsLimit: 20,
    summariesLimit: 5,
    communicationsLimit: 0,
    relevanceThreshold: 0,
  });
});

test('a query-less recall is NOT scoped to the current conversation', async () => {
  // TAC's own instruction on `retrieveMemory`: sending a conversationId without a query makes Memory
  // infer one from that conversation's history — an expensive server-side step. Observations and
  // summaries are profile-scoped and communicationsLimit defaults to 0, so omitting the id costs
  // nothing and saves that inference in the middle of a live turn.
  const client = new RecordingMemoryClient();
  const def = memoryTool(client);
  await def.execute(def.input.parse({}), ctx());

  expect(client.requests[0]?.conversationId).toBeUndefined();
});

test('a recall WITH a query carries the conversation id', async () => {
  const client = new RecordingMemoryClient();
  const def = memoryTool(client);
  await def.execute(def.input.parse({ query: 'desk mat' }), ctx());

  expect(client.requests[0]).toMatchObject({
    conversationId: TEST_CONVERSATION_ID,
    query: 'desk mat',
  });
  expect(client.profileIds).toEqual([TEST_PROFILE_ID]);
});

test('a failed recall is a structured miss and one warning, never a throw', async () => {
  // A throw here would surface as dead air on a phone call.
  const client = new RecordingMemoryClient();
  client.answer = async () => {
    throw new Error('Recall returned 503');
  };
  const logger = collecting();
  const r = (await memoryTool(client).execute({}, ctx(logger))) as Miss;

  expect(r.found).toBe(false);
  expect(logger.lines.map((l) => l.level)).toEqual(['warn']);
  expect(logger.lines[0]?.fields.error).toBe('Recall returned 503');
});

// ------------------------------------------------------------------ search_knowledge

test('a search returns the passages and nothing else', async () => {
  const client = new RecordingKnowledgeClient();
  client.answer = async () => [
    {
      content: 'Most items can be returned within 30 days of delivery.',
      knowledgeId: 'know_1',
      createdAt: '2026-09-14T00:00:00Z',
      score: 1,
    },
    {
      content: 'Refunds go back to the original payment method in 3 to 5 business days.',
      knowledgeId: 'know_2',
      createdAt: '2026-09-14T00:00:00Z',
      score: 0.54,
    },
  ];

  const r = (await knowledgeTool(client).execute({ query: 'return window' }, ctx())) as {
    found: boolean;
    query: string;
    passages: string[];
  };

  expect(r.found).toBe(true);
  expect(r.query).toBe('return window');
  expect(r.passages).toEqual([
    'Most items can be returned within 30 days of delivery.',
    'Refunds go back to the original payment method in 3 to 5 business days.',
  ]);
  // `score` is normalised PER QUERY and is therefore not comparable across queries — measured
  // 2026-09-14, see scripts/verify-knowledge.ts. Handing the model a number it cannot reason about
  // invites it to reason about it anyway, so scores go to the operator's log and no further. The
  // opaque `know_…` id is dropped as noise: it is not something a model can quote to a customer.
  expect(JSON.stringify(r)).not.toContain('know_1');
  expect(JSON.stringify(r)).not.toContain('0.54');
});

test("a search asks for three chunks, not TAC's default of five", async () => {
  // All five probe queries in scripts/verify-knowledge.ts retrieve their intended article within the
  // top 3, and on voice each extra chunk of article prose is latency before the first spoken word.
  const client = new RecordingKnowledgeClient();
  await knowledgeTool(client).execute({ query: 'warranty' }, ctx());

  expect(client.calls).toEqual([{ baseId: TEST_KB_ID, query: 'warranty', topK: 3 }]);
});

test('zero chunks is reported as an unindexed base, not as "no such policy"', async () => {
  // A populated base always returns its closest passages — semantic search never says "I do not
  // know". So zero chunks is a configuration state, which is why it warns.
  const client = new RecordingKnowledgeClient();
  const logger = collecting();
  const r = (await knowledgeTool(client).execute({ query: 'price match' }, ctx(logger))) as Miss;

  expect(r.found).toBe(false);
  expect(r.message).toContain('indexing');
  expect(logger.lines.map((l) => l.level)).toEqual(['debug', 'warn']);
});

test('a missing knowledge base id is a structured miss and one warning', async () => {
  // caps.knowledge is `orchestrated && knowledgeBaseId !== null`, so reaching this means the
  // capability that resolved the tool and the value it was derived from disagree.
  const logger = collecting();
  const r = (await knowledgeTool(new RecordingKnowledgeClient(), null).execute(
    { query: 'shipping' },
    ctx(logger),
  )) as Miss;

  expect(r.found).toBe(false);
  expect(logger.lines.map((l) => l.level)).toEqual(['warn']);
  expect(logger.lines[0]?.fields).toMatchObject({ hasBaseId: false, hasClient: true });
});

test('a missing knowledge client is a structured miss and one warning', async () => {
  const logger = collecting();
  const r = (await knowledgeTool(null).execute({ query: 'shipping' }, ctx(logger))) as Miss;

  expect(r.found).toBe(false);
  expect(logger.lines[0]?.fields).toMatchObject({ hasBaseId: true, hasClient: false });
});

test('a failed search is a structured miss and one warning, never a throw', async () => {
  const client = new RecordingKnowledgeClient();
  client.answer = async () => {
    throw new Error('Search returned 429');
  };
  const logger = collecting();
  const r = (await knowledgeTool(client).execute({ query: 'warranty' }, ctx(logger))) as Miss;

  expect(r.found).toBe(false);
  expect(r.message).toContain('Do not guess');
  expect(logger.lines.map((l) => l.level)).toEqual(['warn']);
  expect(logger.lines[0]?.fields.error).toBe('Search returned 429');
});

// ------------------------------------------------------------------ the descriptions

test('the search_knowledge description steers away from both demo tools by name', () => {
  /**
   * Not decoration. Measured 2026-09-14 against the real base: an out-of-scope order-status query
   * ("Where is my order A4721?") scores 0.816 on its top hit, HIGHER than the in-scope return-window
   * query's own second hit at 0.54. `score` is normalised per query, so no threshold can separate
   * "the base does not know this" from "it does". Content curation and this description are the only
   * two mechanisms keeping knowledge search out of lookup_order's and get_store_hours's territory,
   * and only one of them is in this repo's control at run time.
   */
  const description = knowledgeTool(null).description;
  expect(description).toContain('lookup_order');
  expect(description).toContain('get_store_hours');
  // The consequence of the measurement, stated to the model: a returned passage is not evidence
  // that the library covers the topic.
  expect(description).toContain('even when');
});

test('the retrieve_profile_memory description tells the model when memory is written', () => {
  // Extraction happens only after a conversation reaches INACTIVE or CLOSED. Without that sentence a
  // model calls this to "check" something said thirty seconds ago and reads the empty result as a
  // contradiction.
  const description = named(adapt(), 'retrieve_profile_memory').description;
  expect(description).toContain('ENDED');
  // TAC's schema cannot make `query` required (`required: []`, held by the drift test), so the
  // instruction has to live in the prose.
  expect(description).toContain('Always pass a query');
});
