/**
 * The tool seam. NO vendor imports here, deliberately — not even `ai`.
 *
 * Zod is the single source of truth for a tool's arguments, and a `ToolDef` is vendor-neutral, so
 * the catalog can be built and exercised with no AI SDK, no Twilio and no credentials. The adapter
 * that turns one of these into the `ai` package's `Tool` lives in `server/agent/model/` (T9),
 * because `tests/architecture.test.ts` confines that import to one directory.
 *
 * Why the indirection exists at all: a versioned Langfuse prompt's `config.tools` carries tool
 * NAMES (see `../prompt/port.ts`). Those names resolve against a code-owned catalog, so an
 * operator editing a prompt selects from an allowlist and is structurally incapable of adding a
 * tool or changing an existing tool's arguments.
 */
import { z } from 'zod';
import type { Capabilities } from '../../config.ts';

/**
 * The contract, not a house style. OpenAI rejects a tool name outside roughly this shape, and the
 * rejection arrives as an opaque 400 in the middle of a turn — so the catalog builder checks names
 * at construction, where the failure names the offender and happens before any call is in flight.
 * Anchored, lower-snake, 1–64 characters.
 */
export const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

export const isValidToolName = (name: string): boolean => TOOL_NAME_RE.test(name);

/**
 * Structural, so `childLogger('tools')` satisfies it and a test can collect lines instead of
 * reaching for `vi.mock`.
 *
 * Three levels because this subsystem uses exactly three, and they mean different things:
 * `debug` for a tool's own diagnostics and for an `unavailable` tool (expected in a
 * half-configured demo — that is what capabilities are for); `warn` for a prompt naming a tool
 * the catalog does not have; `error` for the boot preflight.
 */
export interface ToolLogger {
  debug(fields: Record<string, unknown>, msg: string): void;
  warn(fields: Record<string, unknown>, msg: string): void;
  error(fields: Record<string, unknown>, msg: string): void;
}

/**
 * What a tool implementation gets besides its arguments.
 *
 * Two fields, on purpose: a logger so a tool can say what it did, and `conversationId` so those
 * lines can be tied to the turn that caused them. Nothing speculative — T14's TAC built-ins will
 * need a TAC handle and can widen this when they land. A field no tool reads is a field whose
 * meaning nobody can check.
 */
export interface ToolCtx {
  readonly conversationId: string;
  readonly logger: ToolLogger;
}

export interface ToolDef<S extends z.ZodType = z.ZodType> {
  /** Must satisfy `TOOL_NAME_RE`; `createToolCatalog` enforces it. */
  readonly name: string;
  /**
   * The model reads this to decide when to call the tool. It is prompt text, not a code comment:
   * write it for the reader who has to choose between this tool and the one next to it.
   */
  readonly description: string;
  /** The single source of truth for the arguments. Validated before `execute` ever runs. */
  readonly input: S;
  /**
   * The capability this tool needs in order to run at all. Absent means "always available", which
   * is both demo tools — they exist to work with zero credentials so the bench can drive a
   * complete turn on a laptop. The field is what gives the resolver's `unavailable` bucket a real
   * mechanism; T14's Studio handoff and knowledge search are the tools that will set it.
   */
  readonly requires?: keyof Capabilities;
  /**
   * Method syntax rather than an `execute: (args) => ...` property, and that is load-bearing:
   * TypeScript checks method parameters bivariantly, so `ToolDef<ZodObject<{orderId: ...}>>` is
   * assignable to the bare `ToolDef` a heterogeneous catalog holds. Declared as a function
   * property it would be checked contravariantly under `strictFunctionTypes` — `z.output` of the
   * default `z.ZodType` is `unknown` — and every concrete tool would be rejected by the catalog.
   */
  execute(args: z.output<S>, ctx: ToolCtx): Promise<unknown>;
}

/**
 * A tool's arguments as JSON Schema.
 *
 * NOT used on the AI SDK path, which takes the Zod schema directly. Two consumers: the reverse
 * TAC direction at T14, which has to describe tools to Twilio in JSON Schema, and the operator
 * console's tool inspector at T19, which shows what a tool takes without the reader opening the
 * source. Deriving both from the same Zod object is the reason `input` is the single source.
 *
 * `io: 'input'`, not Zod's default of `'output'`, and that argument is load-bearing: both consumers
 * describe what the model must SEND, which is the input position. The two projections diverge the
 * moment a tool's schema does anything on the way through. `z.number().default(10)` is optional
 * inbound and present outbound, so the output projection lists it as `required` — OpenAI and TAC
 * are then told a defaulted field is mandatory and the default never fires. `z.coerce.*`
 * misdescribes the accepted type the same way, and a `.transform()` can make the output side
 * unrepresentable rather than merely wrong.
 *
 * Identical either way for both demo tools, whose arguments are plain `z.string().min(1)`. It is
 * spelled out here because this is the seam T14 and T19 copy, and the symptom of getting it wrong
 * is opaque model behaviour rather than a failure.
 */
export function toJsonSchema(d: ToolDef): unknown {
  return z.toJSONSchema(d.input, { io: 'input' });
}
