/**
 * The catalog: the code-owned allowlist a prompt's tool names resolve against, plus the two demo
 * tools it ships with.
 *
 * The two tools are the worked example a cloner copies, so they are written the way one should be
 * written: validate the input, return structured data, and answer the empty case with a result
 * rather than a thrown error. Their fixtures are deliberately tiny and obviously fake — what is
 * worth copying is the shape, not the data.
 *
 * They also carry a hard constraint from T11: both must work with ZERO credentials of any kind, so
 * the Twilio-free bench harness can drive a complete multi-step turn on a machine with no Twilio
 * account and no orchestrated mode. Neither sets `requires`.
 */
import { z } from 'zod';
import { isValidToolName, TOOL_NAME_RE, type ToolDef } from './registry.ts';

export interface ToolCatalog {
  get(name: string): ToolDef | undefined;
  has(name: string): boolean;
  /** Every tool, in registration order. For the boot preflight and the console's inspector. */
  readonly all: readonly ToolDef[];
  readonly names: readonly string[];
}

/**
 * Build a catalog, rejecting a duplicate or ill-formed name.
 *
 * This one THROWS, unlike almost everything else in the repo — and the shipped catalog below is
 * built at module load, so a broken catalog stops the process at import. That is the right side of
 * "fail loud at boot, degrade quiet at runtime": the catalog is code, not configuration. Nothing
 * an operator or a Langfuse edit can do reaches it, so a failure here is a programming error from
 * a clone's own edit, and the alternatives are worse — a silently dropped tool is a prompt that
 * quietly does less, and a malformed name is an opaque 400 from OpenAI in the middle of a call.
 */
export function createToolCatalog(defs: readonly ToolDef[]): ToolCatalog {
  const byName = new Map<string, ToolDef>();

  for (const def of defs) {
    if (!isValidToolName(def.name)) {
      throw new Error(
        `tool name ${JSON.stringify(def.name)} must match ${TOOL_NAME_RE.source} — OpenAI rejects anything else, mid-turn, as an opaque 400`,
      );
    }
    if (byName.has(def.name)) {
      throw new Error(
        `duplicate tool name ${JSON.stringify(def.name)} — a prompt naming it would get whichever definition happened to be registered last`,
      );
    }
    byName.set(def.name, def);
  }

  const all = [...byName.values()];
  return {
    get: (name) => byName.get(name),
    has: (name) => byName.has(name),
    all,
    names: all.map((d) => d.name),
  };
}

// ------------------------------------------------------------------ lookup_order

interface OrderItem {
  readonly name: string;
  readonly quantity: number;
}

interface Order {
  readonly status: 'processing' | 'shipped' | 'delivered';
  readonly placedOn: string;
  readonly items: readonly OrderItem[];
  /** `null` once delivered, rather than an absent field: a model reads an explicit null correctly. */
  readonly eta: string | null;
}

const ORDERS: Readonly<Record<string, Order>> = {
  A4721: {
    status: 'shipped',
    placedOn: '2026-09-04',
    items: [{ name: 'desk lamp', quantity: 1 }],
    eta: 'Friday 11 September',
  },
  B1832: {
    status: 'processing',
    placedOn: '2026-09-09',
    items: [
      { name: 'standing desk mat', quantity: 2 },
      { name: 'cable tray', quantity: 1 },
    ],
    eta: 'Tuesday 15 September',
  },
  C9003: {
    status: 'delivered',
    placedOn: '2026-08-21',
    items: [{ name: 'monitor arm', quantity: 1 }],
    eta: null,
  },
};

/**
 * An order id deliberately absent from `ORDERS`, so the not-found branch is reachable in a live
 * demo and in the bench harness rather than only in a test. Exported because "deliberately absent"
 * has to be checkable: `tests/tools.test.ts` asserts it stays missing, since adding it to the
 * fixture would silently end the not-found demo.
 */
export const ABSENT_ORDER_ID = 'Z9999';

const LookupOrderInput = z.object({
  orderId: z
    .string()
    .min(1)
    // `.describe()` reaches the model through the generated schema, so it is worth writing: it is
    // where the model learns what an order number looks like without being told in the prompt.
    .describe('The order number, e.g. A4721. Ask the customer for it if you do not have it.'),
});

export const lookupOrder: ToolDef<typeof LookupOrderInput> = {
  name: 'lookup_order',
  description:
    'Look up one order by its order number: current status, the items on it, and the delivery estimate. Returns found: false when no such order exists.',
  input: LookupOrderInput,
  async execute({ orderId }, ctx) {
    // Normalised here rather than in the schema. A model will send "a4721" or " A4721 " sooner or
    // later, and keeping the schema a plain string keeps `toJsonSchema` readable for TAC and the
    // console. Trade-off worth knowing: input coercion that lives in the body is invisible to
    // anything reading the schema.
    const id = orderId.trim().toUpperCase();
    const order = ORDERS[id];

    if (order === undefined) {
      ctx.logger.debug(
        { tool: 'lookup_order', orderId: id, conversationId: ctx.conversationId },
        'lookup_order: no such order',
      );
      // A structured miss, never a throw. A thrown tool error mid-turn is dead air on a live call;
      // an agent saying "I can't find that order, can you read it back to me?" is a working demo.
      return {
        found: false,
        orderId: id,
        message: `No order matching ${id}. Ask the customer to read the order number back, or offer to have someone follow up.`,
      };
    }

    return { found: true, orderId: id, ...order };
  },
};

// ------------------------------------------------------------------ get_store_hours

interface Store {
  readonly location: string;
  readonly weekdays: string;
  readonly saturday: string;
  readonly sunday: string;
  readonly timezone: string;
}

const STORES: Readonly<Record<string, Store>> = {
  downtown: {
    location: 'Downtown',
    weekdays: '9am to 7pm',
    saturday: '10am to 6pm',
    sunday: 'closed',
    timezone: 'America/Chicago',
  },
  airport: {
    location: 'Airport',
    weekdays: '6am to 11pm',
    saturday: '6am to 11pm',
    sunday: '6am to 11pm',
    timezone: 'America/Chicago',
  },
  riverside: {
    location: 'Riverside',
    weekdays: '10am to 6pm',
    saturday: '10am to 4pm',
    sunday: 'closed',
    timezone: 'America/Chicago',
  },
};

const STORE_LOCATIONS: readonly string[] = Object.values(STORES).map((s) => s.location);

const GetStoreHoursInput = z.object({
  location: z
    .string()
    .min(1)
    .describe(`Which store, by name. Known locations: ${STORE_LOCATIONS.join(', ')}.`),
});

/**
 * The second tool, and it exists to be second: `maxSteps > 1` only means something when the model
 * has somewhere else to go, and the console needs two distinct `tool.execution` events to render.
 */
export const getStoreHours: ToolDef<typeof GetStoreHoursInput> = {
  name: 'get_store_hours',
  description: `Get the opening hours for one store by name. Known locations: ${STORE_LOCATIONS.join(', ')}. Returns found: false, plus the locations that do exist, for anything else.`,
  input: GetStoreHoursInput,
  async execute({ location }, ctx) {
    const key = location.trim().toLowerCase();
    const store = STORES[key];

    if (store === undefined) {
      ctx.logger.debug(
        { tool: 'get_store_hours', location, conversationId: ctx.conversationId },
        'get_store_hours: no such location',
      );
      // The miss carries what we DO know, so the agent can offer the real locations instead of
      // apologising into a void. A free-text `location` rather than a `z.enum` is deliberate: a
      // cloner's store list comes from a system of record, not from a schema literal, so this is
      // the branch they will actually need.
      return { found: false, location, knownLocations: STORE_LOCATIONS };
    }

    return { found: true, ...store };
  },
};

// ------------------------------------------------------------------ the shipped catalog

export const DEMO_TOOLS: readonly ToolDef[] = [lookupOrder, getStoreHours];

/** The process-wide catalog. Tests build their own with `createToolCatalog([...])`. */
export const toolCatalog: ToolCatalog = createToolCatalog(DEMO_TOOLS);
