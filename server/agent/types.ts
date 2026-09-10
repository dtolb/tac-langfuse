/**
 * The agent seam. ZERO vendor imports — not `ai`, not `twilio-agent-connect`, not
 * `@langfuse/client`. Every type here is either ours or a Web/Node standard.
 *
 * This is the file that makes the Twilio-free bench harness (T11) a *runtime* proof that voice,
 * SMS and the bench run the same agent: all three build a `TurnDeps`, all three pass a `TurnInput`,
 * and nothing in `run-turn.ts` can tell them apart.
 *
 * `SpanLike` is imported as a TYPE from `../obs/spans.ts`, so nothing here pulls
 * `@langfuse/tracing` in at runtime — the import is erased. That is also why `spans` is a narrow
 * injected port rather than a direct dependency: see `TurnSpans` below.
 */
import type { ObsChannel } from '../../shared/events.ts';
import type { ObsBus } from '../obs/bus.ts';
import type { SpanLike } from '../obs/spans.ts';
import type { ModelPort } from './model/port.ts';
import type { PromptPort } from './prompt/port.ts';
import type { ToolLogger } from './tools/registry.ts';
import type { ToolResolution } from './tools/resolve.ts';

/**
 * `ObsChannel` already says exactly this (`voice | sms | bench`), and a parallel union would be a
 * second list to keep in step with the console's filter UI.
 */
export type TurnChannel = ObsChannel;

/**
 * One message, vendor-neutral.
 *
 * DEVIATION FROM THE PLAN, deliberately: the plan sketched history as `ModelMessage[]`, but
 * `ModelMessage` comes from `ai`, which `tests/architecture.test.ts` confines to
 * `server/agent/model/`. Using it here would put a vendor type on the seam whose whole purpose is
 * to have none, and the bench would stop being a runtime proof of channel-agnosticism.
 * `model/openai.ts` converts.
 */
export interface TurnMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface TurnInput {
  readonly conversationId: string;
  readonly channel: TurnChannel;
  readonly userText: string;
  /** Verbatim TAC memory payload. Opaque here; only `composeMemory` knows its shape. */
  readonly memory: unknown | null;
  /** Carries the `traceparent` across turns — see `TRACEPARENT_KEY` in `../obs/spans.ts`. */
  readonly sessionMetadata: Record<string, unknown>;
  readonly profileId: string | null;
  readonly abortSignal: AbortSignal;
  /**
   * The turn span — created AND ended by the CALLER, inside `withTurnSpan`. `runTurn` writes
   * attributes onto it and must never call `end()`. See the header of `run-turn.ts` for why.
   */
  readonly span: SpanLike;
}

export interface TurnToolCall {
  readonly name: string;
  /** The arguments the model sent, after schema validation. */
  readonly input: unknown;
}

/** `null` rather than `0` where the provider reported nothing: 0 tokens reads as a real answer. */
export interface TurnUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
}

export interface TurnResult {
  readonly text: string;
  readonly toolCalls: readonly TurnToolCall[];
  readonly usage: TurnUsage;
  /** Steps the tool loop took. 1 means a plain answer; >1 means at least one tool round-trip. */
  readonly steps: number;
  /** Both derived from `FirstTokenMarks`, never recomputed — that module owns the definition. */
  readonly ttftMs: number | null;
  readonly totalMs: number | null;
  /** Barge-in on voice. Normal operation, not an error. */
  readonly aborted: boolean;
  /**
   * Which prompt version answered, and on which model. Not strictly part of "the answer", but the
   * caller cannot attribute a result without it and it is what the operator console renders next
   * to the text — the same facts the turn span carries, for the ephemeral path.
   */
  readonly prompt: { readonly name: string; readonly version: number | 'fallback'; readonly label: string | null };
  readonly model: string;
}

export interface TurnOutput {
  /**
   * Consume exactly once.
   *
   * `done` does not settle until this has been drained (or abandoned mid-flight). That is forced:
   * the timings live in a `FirstTokenMarks` object that is mutated AS the stream drains, so a
   * `done` that settled earlier would report `null`.
   */
  readonly tokens: AsyncIterable<string>;
  readonly done: Promise<TurnResult>;
}

/**
 * Fold TAC's memory payload into extra system context.
 *
 * A port rather than a direct call because TAC's `MemoryPromptBuilder` lives inside the vendor
 * boundary. This single injected port is what keeps `run-turn.ts` TAC-free while still using TAC's
 * memory folding at T13. `passthroughMemory` in `./memory.ts` is what the bench and
 * SMS-without-orchestration use.
 */
export interface MemoryComposePort {
  compose(input: {
    readonly memory: unknown | null;
    readonly conversationId: string;
    readonly channel: TurnChannel;
  }): Promise<string | null>;
}

/**
 * T8's `resolve()` with its process-wide arguments (capabilities, catalog, bus) already applied.
 *
 * Partially applied rather than passed whole, because `capabilities` comes from `server/config.ts`
 * and `server/agent/` reads no environment. The caller closes over it.
 */
export type ToolResolvePort = (
  names: readonly string[],
  turn: { readonly conversationId: string; readonly channel: TurnChannel },
) => ToolResolution;

/**
 * The span operations `runTurn` uses, and only those.
 *
 * INJECTED rather than imported, for one reason: the required unit test asserts the span TREE.
 * Asserting a real OpenTelemetry tree needs a registered provider, a `SimpleSpanProcessor` that
 * exports on a deferred tick, and reading the exporter BEFORE `shutdown()` resets its buffer — at
 * which point it is an OTel integration test, not a unit test of this function. A recording fake
 * makes it a real unit test. `server/agent/spans.ts` holds the one production implementation and
 * it wraps `server/obs/spans.ts`, so the rule that every span goes through that module still holds
 * at run time.
 */
export interface TurnSpans {
  /** A timed child step. Ends on both the success and the error path. */
  timeStep<T>(
    name: string,
    fn: () => Promise<T>,
    describe?: (result: T) => Record<string, unknown>,
  ): Promise<T>;
  /** A child step whose `end()` the caller owns — for a step that outlives `runTurn` itself. */
  startStep(name: string, input?: Record<string, unknown>): SpanLike;
}

/**
 * The two slots that are demo branding rather than per-turn facts.
 *
 * `channel` and `current_date` — the other two names `../agent/prompt/slots.ts` allows — are
 * derived by `runTurn` from the turn and the clock. A caller-supplied date would go stale, and a
 * caller-supplied channel could disagree with `TurnInput.channel`.
 */
export interface TurnBranding {
  readonly persona: string;
  readonly companyName: string;
}

/**
 * The long-lived dependencies. Per-turn values belong in `TurnInput`.
 *
 * `obs` is T7/T8's existing `ObsBus`, narrowed to what is used. There is deliberately no parallel
 * `ObsPort` saying the same thing.
 */
export interface TurnDeps {
  readonly prompts: PromptPort;
  readonly tools: ToolResolvePort;
  readonly model: ModelPort;
  readonly composeMemory: MemoryComposePort;
  readonly obs: Pick<ObsBus, 'publish'>;
  readonly spans: TurnSpans;
  readonly branding: TurnBranding;
  /** `ToolLogger`'s three levels are exactly the three this function uses. */
  readonly logger?: ToolLogger;
  /** Injected so timings are exact in tests rather than tolerant of a wall clock. */
  readonly now?: () => number;
}
