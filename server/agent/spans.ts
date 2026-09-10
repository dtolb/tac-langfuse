/**
 * The one production `TurnSpans`. A thin adapter, and thin on purpose.
 *
 * `runTurn` takes its span operations by injection so the unit test can assert the span tree
 * against a recording fake (see `TurnSpans` in `./types.ts`). This module is the other half of that
 * bargain: at run time there is exactly one implementation and it delegates straight to
 * `server/obs/spans.ts`, so the repo-wide rule still holds — every span is created through
 * `@langfuse/tracing`, never a raw OpenTelemetry tracer.
 *
 * That rule is not pedantry. `LangfuseSpanProcessor` FILTERS: a span from
 * `trace.getTracer(x).startActiveSpan(...)` is created perfectly well, an in-memory exporter sees
 * it, it has a real sampled trace id — and it is then silently dropped on the way to Langfuse with
 * no error anywhere. Read the header of `server/obs/spans.ts` before adding anything here.
 *
 * Both operations pick up the AMBIENT OpenTelemetry context, which is why they nest under the
 * caller's turn span without being handed it: `runTurn` runs inside the caller's `withTurnSpan`
 * callback.
 */
import { startStep, timeStep } from '../obs/spans.ts';
import type { TurnSpans } from './types.ts';

export const turnSpans: TurnSpans = { timeStep, startStep };
