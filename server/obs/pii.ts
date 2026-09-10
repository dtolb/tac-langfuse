/**
 * PII scrubbing for everything this app logs.
 *
 * Deliberately a copy of TAC's approach rather than an import of its `scrubObject`. Two
 * reasons, and the second is the real one:
 *
 *  1. Importing `twilio-agent-connect` here would breach the vendor boundary that
 *     `tests/architecture.test.ts` enforces, for a utility rather than a capability.
 *  2. TAC's hook only covers TAC's own logger. OUR code is the code that logs transcripts,
 *     caller names, and tool arguments — so we need a scrubber on our side regardless of
 *     what TAC does internally.
 *
 * `tests/pii.test.ts` asserts this masks the same shapes TAC's does, so the two cannot drift
 * into disagreeing about what counts as sensitive.
 */

// A leading + then at least 8 digits total, tolerating spaces, dashes and parens.
const PHONE_RE = /\+\d[\d\s()-]{6,}\d/g;
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

const maskPhoneMatch = (match: string): string => {
  const digits = match.replace(/[\s\-()]/g, '');
  if (digits.length < 8) return '***';
  return `${digits.slice(0, 2)}***${digits.slice(-4)}`;
};

const maskEmailMatch = (match: string): string => {
  const at = match.indexOf('@');
  if (at <= 0) return '***';
  return `${match[0] ?? ''}***${match.slice(at)}`;
};

/** Mask phone numbers and email addresses inside a free-text string. */
export const scrubPii = (value: string): string =>
  value.replace(PHONE_RE, maskPhoneMatch).replace(EMAIL_RE, maskEmailMatch);

/**
 * Mask a known-E.164 number, for the case where the value is a phone number rather than
 * text that might contain one: `+15551234567` -> `+1***4567`.
 */
export const maskPhone = (phone: string | undefined): string => {
  if (!phone || !phone.startsWith('+') || phone.length < 8) return '***';
  return `${phone.slice(0, 2)}***${phone.slice(-4)}`;
};

/**
 * How deep a nested value is walked before it is replaced with `[MaxDepth]`.
 *
 * A BOUND ON THE WALK, not a formatting preference, and the ancestor-path tracking below is what
 * makes it necessary. Because a node is REMOVED from the set on the way out, a shared subtree is
 * re-walked once per reference — so `{a: n, b: n}` nested d deep costs 2^d walks. Measured on the
 * unbounded version: 90 ms at depth 18, 333 ms at 20, 1326 ms at 22, extrapolating to minutes by 30.
 * That is a hang in the one function every log line, obs event and span payload passes through.
 *
 * Nothing today can reach it — `JSON.parse` cannot produce a shared reference, so model-supplied
 * tool arguments are always trees, and the payloads this app builds are shallow literals. The cap
 * exists so the worst failure mode available here (a wedged process, no error anywhere) is not
 * reachable by a future payload either. 12 is well clear of what this app logs — a turn span's
 * `output` and a `tool.execution` payload both sit at 3 or 4 levels — and it bounds the DAG blowup
 * at 2^12 walks, which is microseconds.
 *
 * A node budget would bound it equally well and was the alternative; depth wins because it degrades
 * predictably — the same input always truncates in the same place, whereas a budget makes the
 * output depend on sibling order.
 */
const MAX_DEPTH = 12;

/**
 * Recursively scrub a value of any shape.
 *
 * Four behaviours worth knowing, the first three matching TAC:
 *  - cycles become the string `[Circular]` rather than throwing;
 *  - `Error` is rebuilt preserving its prototype, with message/stack scrubbed, because a
 *    plain spread of an Error loses both (they are non-enumerable);
 *  - a value whose prototype is not `Object.prototype` is returned UNTOUCHED. Class
 *    instances, Date, Buffer, streams and sockets pass through — walking them would be
 *    ruinous, and a logger should never mutate a live handle.
 *  - anything nested deeper than `MAX_DEPTH` becomes `[MaxDepth]`. See that constant.
 */
export const scrubObject = (value: unknown, seen?: WeakSet<object>, depth = 0): unknown => {
  if (typeof value === 'string') return scrubPii(value);
  if (value === null || typeof value !== 'object') return value;
  // Only objects are capped, because only objects recurse: a string this deep is a leaf that costs
  // one regex pass, and masking it is the whole job.
  if (depth >= MAX_DEPTH) return '[MaxDepth]';

  // The set tracks the CURRENT ANCESTOR PATH, not every node ever seen — note the `delete` in the
  // `finally` below. Tracking all visited nodes instead looks equivalent and is not: it reports the
  // second reference to a shared object as a cycle, so any payload that is a DAG rather than a tree
  // silently loses data. Measured before the fix: `{toolCalls: names, 'tools.called': names}` with
  // one array bound twice scrubbed to `{"toolCalls":[...],"tools.called":"[Circular]"}`, which is how
  // `tools.called` was reaching Langfuse. Repeated references are ordinary here — the same array or
  // record routinely appears as both a span `output` field and a metadata attribute.
  const visited = seen ?? new WeakSet<object>();
  if (visited.has(value)) return '[Circular]';
  visited.add(value);

  try {
    return scrubBody(value, visited, depth + 1);
  } finally {
    visited.delete(value);
  }
};

/** The per-shape scrubbing, split out only so `scrubObject` can own the ancestor-path bookkeeping. */
const scrubBody = (value: object, visited: WeakSet<object>, depth: number): unknown => {
  if (value instanceof Error) {
    const source = value as unknown as Record<string, unknown>;
    const rebuilt = Object.create(Object.getPrototypeOf(value)) as Record<string, unknown>;
    for (const key of Object.keys(source)) {
      rebuilt[key] = scrubObject(source[key], visited, depth);
    }
    // message/name/stack are non-enumerable, so Object.keys missed them.
    if (!Object.prototype.hasOwnProperty.call(rebuilt, 'message')) {
      rebuilt.message = scrubPii(value.message);
    }
    if (!Object.prototype.hasOwnProperty.call(rebuilt, 'name')) {
      rebuilt.name = value.name;
    }
    if (value.stack && !Object.prototype.hasOwnProperty.call(rebuilt, 'stack')) {
      rebuilt.stack = scrubPii(value.stack);
    }
    return rebuilt;
  }

  if (Array.isArray(value)) return value.map((item) => scrubObject(item, visited, depth));
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;

  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    out[key] = scrubObject(source[key], visited, depth);
  }
  return out;
};

/**
 * pino `hooks.logMethod` implementation. Installed on the ONE pino instance, which is why
 * handing a child of that instance to `TAC.create({ logger })` keeps scrubbing intact — the
 * hook lives on the instance, not on the call site.
 */
export function piiLogMethod(
  this: unknown,
  args: unknown[],
  method: (...a: unknown[]) => void,
): void {
  method.apply(
    this,
    args.map((arg) => (typeof arg === 'string' || (typeof arg === 'object' && arg !== null) ? scrubObject(arg) : arg)),
  );
}
