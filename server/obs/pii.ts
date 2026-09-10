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
 * Recursively scrub a value of any shape.
 *
 * Three behaviours worth knowing, all matching TAC:
 *  - cycles become the string `[Circular]` rather than throwing;
 *  - `Error` is rebuilt preserving its prototype, with message/stack scrubbed, because a
 *    plain spread of an Error loses both (they are non-enumerable);
 *  - a value whose prototype is not `Object.prototype` is returned UNTOUCHED. Class
 *    instances, Date, Buffer, streams and sockets pass through — walking them would be
 *    ruinous, and a logger should never mutate a live handle.
 */
export const scrubObject = (value: unknown, seen?: WeakSet<object>): unknown => {
  if (typeof value === 'string') return scrubPii(value);
  if (value === null || typeof value !== 'object') return value;

  const visited = seen ?? new WeakSet<object>();
  if (visited.has(value)) return '[Circular]';
  visited.add(value);

  if (value instanceof Error) {
    const source = value as unknown as Record<string, unknown>;
    const rebuilt = Object.create(Object.getPrototypeOf(value)) as Record<string, unknown>;
    for (const key of Object.keys(source)) {
      rebuilt[key] = scrubObject(source[key], visited);
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

  if (Array.isArray(value)) return value.map((item) => scrubObject(item, visited));
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;

  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    out[key] = scrubObject(source[key], visited);
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
