/**
 * The model seam. NO vendor imports — `model/openai.ts` next door is the only file in the repo
 * allowed to import `ai` and `@ai-sdk/openai` (`tests/architecture.test.ts` enforces it), so
 * swapping provider is one file rather than an architecture change.
 *
 * `stream()` returns the SAME `{tokens, done}` shape `runTurn` hands outward, because `runTurn`'s
 * job is to enrich that shape — with timings, span attributes and obs events — not to reshape it.
 */
import type { ToolCtx, ToolDef } from '../tools/registry.ts';
import type { TurnMessage, TurnToolCall, TurnUsage } from '../types.ts';

export interface ModelTelemetry {
  /** Groups traces in Langfuse. One value per channel, so voice and SMS are separable. */
  readonly functionId: string;
  /**
   * `ResolvedPrompt.telemetryLink`, present ONLY when Langfuse served a real version. Absent —
   * not `null` — on the compiled fallback, because a fallback must not claim a version.
   *
   * Deliberately `unknown`: this port is vendor-neutral, and turning the link into whatever shape
   * the tracing integration currently wants is `openai.ts`'s job. See `langfusePromptLink` there.
   */
  readonly promptLink?: unknown;
}

export interface ModelRequest {
  readonly model: string;
  readonly system: string;
  readonly messages: readonly TurnMessage[];
  readonly tools: readonly ToolDef[];
  readonly toolChoice: 'auto' | 'none' | 'required';
  /** From the prompt version's `config.maxSteps`. A ceiling on the tool loop. */
  readonly maxSteps: number;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly abortSignal: AbortSignal;
  /** Passed to every tool's `execute`. Built per turn so a tool's log lines name their turn. */
  readonly toolCtx: ToolCtx;
  readonly telemetry: ModelTelemetry;
}

export interface ModelStreamResult {
  readonly text: string;
  /** What the model ASKED for — including a call whose `execute` then threw. */
  readonly toolCalls: readonly TurnToolCall[];
  readonly usage: TurnUsage;
  /** Steps the tool loop actually took, so hitting `maxSteps` is visible rather than inferred. */
  readonly steps: number;
}

export interface ModelPort {
  /**
   * Never throws synchronously, and never rejects: a failure surfaces on `done`.
   *
   * That is not stylistic. A synchronous throw is unhandleable by a voice caller that has already
   * committed to speaking — this repo has been bitten by TAC's `sendResponse` doing exactly that.
   */
  stream(request: ModelRequest): {
    readonly tokens: AsyncIterable<string>;
    readonly done: Promise<ModelStreamResult>;
  };
}
