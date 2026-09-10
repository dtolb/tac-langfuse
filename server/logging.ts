/**
 * ONE pino instance for the whole process, and two views onto it.
 *
 * The single-instance rule is what makes PII scrubbing hold end to end. Scrubbing is a pino
 * `hooks.logMethod` installed on the INSTANCE, so:
 *
 *   - `tacLogger()` hands TAC a *child* of this instance. Children inherit the hook, so
 *     injecting our own logger into `TAC.create({ logger })` does NOT lose the scrubbing that
 *     TAC's own `createLogger` would have applied. That was the one real worry about logger
 *     injection, and this is the answer to it.
 *   - `log` is the LogLayer view for our application code, wrapping the same instance, so
 *     everything lands on one stream with one format and one level.
 *
 * `console.*` is banned by tests/architecture.test.ts precisely because it bypasses the hook.
 */
import pino from 'pino';
import { LogLayer } from 'loglayer';
import { PinoTransport } from '@loglayer/transport-pino';
import { piiLogMethod } from './obs/pii.ts';

/**
 * TWILIO_LOG_LEVEL rather than a name of our own: TAC's own logger and its default Fastify
 * logger both read that variable, so one knob controls every component's verbosity instead
 * of three that can disagree.
 */
const level = process.env.TWILIO_LOG_LEVEL ?? 'info';

export const rootLogger = pino({
  level,
  // The scrubber. Applies to every call on this instance and on every child of it.
  hooks: { logMethod: piiLogMethod },
  // Emit `time` as ISO rather than epoch ms so a log line pasted into a bug report is
  // readable without conversion. Costs a little throughput; worth it for a demo tool.
  timestamp: pino.stdTimeFunctions.isoTime,
  // Drop pid/hostname noise — one process per container, and the container name is the host.
  // Must be `null`, not `undefined`: pino types this as `{...} | null`, and
  // exactOptionalPropertyTypes makes the difference a compile error rather than a surprise.
  base: null,
});

/** A child tagged for a subsystem. Use this for anything that isn't application logic. */
export const childLogger = (component: string): pino.Logger =>
  rootLogger.child({ component });

/**
 * The logger to pass to `TAC.create({ config, logger })`.
 *
 * TAC derives its own children from whatever it is given (`{component:'conversation'}`,
 * `'memory'`, `'knowledge'`, `'channel'`, …), so tagging it once here is enough to make every
 * TAC line attributable without touching TAC.
 */
export const tacLogger = (): pino.Logger => childLogger('tac');

/** Application-code logger. Structured, scrubbed, same stream as everything else. */
export const log = new LogLayer({
  transport: new PinoTransport({ logger: rootLogger }),
});
