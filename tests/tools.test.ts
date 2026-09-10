import { test, expect } from 'vitest';
import { z } from 'zod';
import {
  ABSENT_ORDER_ID,
  createToolCatalog,
  getStoreHours,
  lookupOrder,
  toolCatalog,
} from '../server/agent/tools/catalog.ts';
import {
  isValidToolName,
  toJsonSchema,
  type ToolCtx,
  type ToolDef,
  type ToolLogger,
} from '../server/agent/tools/registry.ts';
import {
  preflightDefaultPromptTools,
  resolve,
  type ResolveDeps,
} from '../server/agent/tools/resolve.ts';
import { DEFAULT_PROMPTS, PROMPT_NAMES } from '../server/agent/prompt/defaults.ts';
import type { Capabilities } from '../server/config.ts';
import { createObsBus, type ObsBus } from '../server/obs/bus.ts';
import type { ObsEvent } from '../shared/events.ts';

// ------------------------------------------------------------------ fakes, injected not mocked

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

/** Everything off except the two a laptop with an OpenAI key has, which is the T11 baseline. */
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
 * A stand-in tool. Used instead of shipping a placeholder with `requires` set — the two demo tools
 * deliberately have no capability dependency, and adding one just to have something to test would
 * put a tool in the product that exists for the test suite.
 */
const fixture = (name: string, requires?: keyof Capabilities): ToolDef => ({
  name,
  description: `fixture ${name}`,
  input: z.object({}),
  ...(requires !== undefined && { requires }),
  execute: async () => ({ ok: true }),
});

const ctx = (logger: ToolLogger = silent): ToolCtx => ({ conversationId: 'test-conv', logger });

const capture = (): { readonly bus: ObsBus; readonly events: readonly ObsEvent[] } => {
  const bus = createObsBus();
  const events: ObsEvent[] = [];
  bus.subscribe((e) => void events.push(e));
  return { bus, events };
};

/** Silent by default so a passing run prints nothing; each case overrides what it asserts on. */
const deps = (over: Partial<ResolveDeps> = {}): ResolveDeps => ({
  capabilities: caps(),
  logger: silent,
  bus: createObsBus(),
  ...over,
});

// ------------------------------------------------------------------ catalog construction

test('a duplicate tool name fails when the catalog is built', () => {
  // Not at the model call, where the loser of the collision is whichever was registered last.
  expect(() => createToolCatalog([fixture('lookup_order'), fixture('lookup_order')])).toThrow(
    /duplicate tool name/,
  );
});

test.each(['Bad-Name', '9lives', '', 'lookup order', 'lookupOrder', 'a'.repeat(65)])(
  'an ill-formed tool name (%j) fails when the catalog is built',
  (name) => {
    // OpenAI rejects each of these, mid-turn, as an opaque 400.
    expect(() => createToolCatalog([fixture(name)])).toThrow(/must match/);
  },
);

test('the 64-character limit is not off by one', () => {
  expect(isValidToolName('a'.repeat(64))).toBe(true);
  expect(isValidToolName('a'.repeat(65))).toBe(false);
  expect(() => createToolCatalog([fixture('a'.repeat(64))])).not.toThrow();
});

test('the shipped catalog holds exactly the two credential-free demo tools', () => {
  // The T11 constraint: a complete multi-step turn has to be drivable with no credentials at all.
  expect(toolCatalog.names).toEqual(['lookup_order', 'get_store_hours']);
  expect(toolCatalog.all.every((t) => t.requires === undefined)).toBe(true);
  expect(toolCatalog.get('lookup_order')).toBe(lookupOrder);
  expect(toolCatalog.has('send_message')).toBe(false);
});

// ------------------------------------------------------------------ resolve: the three buckets

test('one resolve call partitions into resolved, unknown and unavailable', () => {
  const catalog = createToolCatalog([lookupOrder, getStoreHours, fixture('search_knowledge', 'knowledge')]);
  const logger = collecting();
  const { bus, events } = capture();

  const r = resolve(
    // The repeated first name is deliberate: it is what pins `payload.considered` as the deduped
    // set rather than the raw list the prompt named.
    ['lookup_order', 'search_knowledge', 'send_message', 'get_store_hours', 'lookup_order'],
    deps({ catalog, capabilities: caps({ knowledge: false }), logger, bus }),
  );

  expect(r.resolved.map((t) => t.name)).toEqual(['lookup_order', 'get_store_hours']);
  expect(r.unknown).toEqual(['send_message']);
  expect(r.unavailable).toEqual(['search_knowledge']);

  // One warning, for the unknown name only. An unavailable tool is the expected state of a
  // half-configured demo and would train the reader to ignore the line above it.
  expect(logger.lines.filter((l) => l.level === 'warn')).toHaveLength(1);
  expect(logger.lines.find((l) => l.level === 'warn')?.msg).toContain('send_message');

  expect(events).toHaveLength(1);
  expect(events[0]?.kind).toBe('tool.selection');
  expect(events[0]?.summary).toBe(
    '2 of 4 tools resolved — unknown: send_message — unavailable: search_knowledge',
  );
  expect(events[0]?.payload).toEqual({
    // Five names in, four out, in the prompt's order — the field says `considered`, not
    // `requested`, because that collapse is exactly what it holds.
    considered: ['lookup_order', 'search_knowledge', 'send_message', 'get_store_hours'],
    resolved: ['lookup_order', 'get_store_hours'],
    unknown: ['send_message'],
    unavailable: ['search_knowledge'],
  });
});

test('an unsatisfied capability lands in unavailable, not unknown, and not resolved', () => {
  const catalog = createToolCatalog([fixture('search_knowledge', 'knowledge')]);
  const r = resolve(['search_knowledge'], deps({ catalog, capabilities: caps({ knowledge: false }) }));

  expect(r.unavailable).toEqual(['search_knowledge']);
  expect(r.unknown).toEqual([]);
  expect(r.resolved).toEqual([]);
});

test('the same tool resolves once its capability is satisfied', () => {
  // Proves the flag is actually read, rather than `requires` meaning "never available".
  const catalog = createToolCatalog([fixture('search_knowledge', 'knowledge')]);
  const r = resolve(['search_knowledge'], deps({ catalog, capabilities: caps({ knowledge: true }) }));

  expect(r.resolved.map((t) => t.name)).toEqual(['search_knowledge']);
  expect(r.unavailable).toEqual([]);
});

test('a prompt naming a dead tool still gets the tools that did resolve', () => {
  // The whole point of the never-throws contract: a bad prompt version must not end a phone call.
  const logger = collecting();
  const { bus, events } = capture();
  const r = resolve(
    ['lookup_order', 'no_such_tool'],
    deps({ catalog: toolCatalog, logger, bus }),
  );

  expect(r.resolved.map((t) => t.name)).toEqual(['lookup_order']);
  expect(r.unknown).toEqual(['no_such_tool']);
  expect(logger.lines.map((l) => l.level)).toEqual(['warn']);
  expect(events[0]?.summary).toBe('1 of 2 tools resolved — unknown: no_such_tool');
});

test('resolve never throws, whatever it is handed', () => {
  const catalog = createToolCatalog([lookupOrder]);
  const run = (names: readonly string[]): ReturnType<typeof resolve> =>
    resolve(names, deps({ catalog }));

  expect(run([])).toEqual({ resolved: [], unknown: [], unavailable: [] });
  expect(run(['nope', 'nope', 'nope']).unknown).toEqual(['nope']);
  // An empty and a whitespace-only name are distinct misses, and neither is fatal. They are quoted
  // in the warning for the same reason slots.ts renders a marker: an invisible name reads as a
  // formatting slip rather than as the prompt bug it is.
  expect(run(['', ' ']).unknown).toEqual(['', ' ']);
  expect(run(['lookup_order', '']).resolved.map((t) => t.name)).toEqual(['lookup_order']);
});

test('the event is published even when the prompt asked for no tools', () => {
  // "0 of 0 tools resolved" is the answer to "why did the agent never call a tool?", and that
  // question gets asked mid-demo.
  const { bus, events } = capture();
  resolve([], deps({ catalog: toolCatalog, bus }));
  expect(events.map((e) => e.summary)).toEqual(['0 of 0 tools resolved']);
});

// ------------------------------------------------------------------ resolve: order and dedup

test('resolved follows the prompt order, not the catalog order', () => {
  // Tool order is part of what a prompt version controls, so it survives the round trip.
  const r = resolve(['get_store_hours', 'lookup_order'], deps({ catalog: toolCatalog }));
  expect(r.resolved.map((t) => t.name)).toEqual(['get_store_hours', 'lookup_order']);
});

test('a repeated name is offered, counted and reported once', () => {
  const { bus, events } = capture();
  const logger = collecting();
  const r = resolve(
    ['lookup_order', 'lookup_order', 'nope', 'nope'],
    deps({ catalog: toolCatalog, bus, logger }),
  );

  expect(r.resolved.map((t) => t.name)).toEqual(['lookup_order']);
  expect(r.unknown).toEqual(['nope']);
  // Deduped before counting, so the badge reads 1 of 2 rather than 1 of 4.
  expect(events[0]?.summary).toBe('1 of 2 tools resolved — unknown: nope');
  expect(logger.lines).toHaveLength(1);
});

test('the event carries the conversation and channel when the caller supplies them', () => {
  const { bus, events } = capture();
  resolve(
    ['lookup_order'],
    deps({ catalog: toolCatalog, bus, conversationId: 'CH123', channel: 'voice' }),
  );
  expect(events[0]?.conversationId).toBe('CH123');
  expect(events[0]?.channel).toBe('voice');
});

test('resolve uses the shipped catalog when none is injected', () => {
  const r = resolve(['lookup_order', 'get_store_hours'], deps());
  expect(r.resolved.map((t) => t.name)).toEqual(['lookup_order', 'get_store_hours']);
  expect(r.unknown).toEqual([]);
});

// ------------------------------------------------------------------ the compiled defaults

test('every tool name in every compiled default exists in the catalog', () => {
  // What stops a checked-in prompt from shipping a name nothing answers to.
  for (const prompt of PROMPT_NAMES) {
    for (const name of DEFAULT_PROMPTS[prompt].config.tools) {
      expect(toolCatalog.names, `${prompt} names ${name}`).toContain(name);
    }
  }
});

test('the boot preflight has nothing to say about the shipped defaults', () => {
  const logger = collecting();
  expect(preflightDefaultPromptTools({ logger })).toEqual([]);
  expect(logger.lines).toEqual([]);
});

test('the preflight logs one ERROR per offending name, naming the prompt and the tool', () => {
  const logger = collecting();
  const problems = preflightDefaultPromptTools({ catalog: createToolCatalog([]), logger });

  // An empty catalog answers to nothing, so every name in every default is an offender. Derived
  // from DEFAULT_PROMPTS rather than hard-coded, so editing a default cannot make this vacuous.
  const named = PROMPT_NAMES.flatMap((p) =>
    DEFAULT_PROMPTS[p].config.tools.map((name) => ({ prompt: p, name })),
  );
  expect(named.length).toBeGreaterThan(0);
  expect(problems).toEqual(named);
  // One line per name, at ERROR — the loud half of "fail loud at boot, degrade quiet at runtime".
  expect(logger.lines.map((l) => l.level)).toEqual(named.map(() => 'error'));
  expect(logger.lines[0]?.fields.prompt).toBe(named[0]?.prompt);
  expect(logger.lines[0]?.msg).toContain(named[0]?.name);
});

// ------------------------------------------------------------------ lookup_order

test('lookup_order requires a non-empty order id', () => {
  expect(lookupOrder.input.safeParse({}).success).toBe(false);
  expect(lookupOrder.input.safeParse({ orderId: '' }).success).toBe(false);
  expect(lookupOrder.input.safeParse({ orderId: 42 }).success).toBe(false);
  expect(lookupOrder.input.safeParse({ orderId: 'A4721' }).success).toBe(true);
});

test('lookup_order returns structured data for an order that exists', async () => {
  // Sloppy casing and whitespace are what a model actually sends, and both must hit.
  const r = (await lookupOrder.execute({ orderId: ' a4721 ' }, ctx())) as Record<string, unknown>;
  expect(r).toMatchObject({ found: true, orderId: 'A4721', status: 'shipped' });
  expect(r.items).toEqual([{ name: 'desk lamp', quantity: 1 }]);
  expect(r.eta).toEqual(expect.any(String));
});

test('lookup_order answers the deliberately-absent id instead of throwing', async () => {
  // A thrown tool error mid-turn is dead air; "I can't find that order" is a working demo. This is
  // also the tripwire on ABSENT_ORDER_ID: adding it to the fixture ends the not-found demo.
  const logger = collecting();
  const r = (await lookupOrder.execute({ orderId: ABSENT_ORDER_ID }, ctx(logger))) as Record<
    string,
    unknown
  >;
  expect(r).toMatchObject({ found: false, orderId: ABSENT_ORDER_ID });
  expect(r.message).toEqual(expect.any(String));
  // A diagnostic, not a warning: nothing is wrong with the process.
  expect(logger.lines.map((l) => l.level)).toEqual(['debug']);
});

// ------------------------------------------------------------------ get_store_hours

test('get_store_hours requires a non-empty location', () => {
  expect(getStoreHours.input.safeParse({}).success).toBe(false);
  expect(getStoreHours.input.safeParse({ location: '' }).success).toBe(false);
  expect(getStoreHours.input.safeParse({ location: 'Downtown' }).success).toBe(true);
});

test('get_store_hours returns hours for a known location, whatever the casing', async () => {
  const r = (await getStoreHours.execute({ location: 'DOWNTOWN' }, ctx())) as Record<string, unknown>;
  expect(r).toMatchObject({ found: true, location: 'Downtown' });
  expect(r.weekdays).toEqual(expect.any(String));
  expect(r.sunday).toEqual(expect.any(String));
});

test('get_store_hours answers an unknown location with the ones that do exist', async () => {
  // So the agent can offer the real locations rather than apologising into a void.
  const r = (await getStoreHours.execute({ location: 'Mars' }, ctx())) as {
    found: boolean;
    location: string;
    knownLocations: readonly string[];
  };
  expect(r.found).toBe(false);
  expect(r.location).toBe('Mars');
  expect(r.knownLocations).toContain('Downtown');
});

// ------------------------------------------------------------------ toJsonSchema

test('toJsonSchema exposes the properties the Zod input declares', () => {
  // Only the parts T14 (describing tools to Twilio) and T19 (the console inspector) consume.
  // Pinning the whole document would make a Zod upgrade look like a regression.
  const schema = toJsonSchema(lookupOrder) as {
    type?: string;
    properties?: Record<string, { type?: string; description?: string }>;
    required?: readonly string[];
  };

  expect(schema.type).toBe('object');
  expect(Object.keys(schema.properties ?? {})).toEqual(['orderId']);
  expect(schema.properties?.orderId?.type).toBe('string');
  // `.describe()` on the Zod field is how the model learns what an order number looks like, so it
  // has to survive the conversion.
  expect(schema.properties?.orderId?.description).toContain('order number');
  expect(schema.required).toEqual(['orderId']);
});

test('toJsonSchema emits the input projection, so a defaulted argument is not required', () => {
  // The distinction the two demo tools cannot show: their arguments are plain `z.string().min(1)`,
  // where the input and output projections are identical. A `.default()` is where they diverge —
  // optional on the way in, present on the way out — and it is the input position that describes
  // what the model must SEND. Under Zod's default `io: 'output'` this schema would tell OpenAI and
  // TAC that `limit` is mandatory, and the default would never fire.
  const withDefault: ToolDef = {
    name: 'paged_fixture',
    description: 'fixture whose input carries a default',
    input: z.object({ query: z.string(), limit: z.number().default(10) }),
    execute: async () => ({ ok: true }),
  };

  const schema = toJsonSchema(withDefault) as {
    properties?: Record<string, { default?: unknown }>;
    required?: readonly string[];
  };

  expect(Object.keys(schema.properties ?? {})).toEqual(['query', 'limit']);
  expect(schema.required).toEqual(['query']);
  expect(schema.required).not.toContain('limit');
  // The default itself still reaches the model as documentation of what happens if it says nothing.
  expect(schema.properties?.limit?.default).toBe(10);
});
