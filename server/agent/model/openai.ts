/**
 * The ONLY file in the repo allowed to import `ai` and `@ai-sdk/openai`
 * (`tests/architecture.test.ts` enforces it). Everything above this line is vendor-neutral, which
 * is what makes the provider swappable in one file and the bench harness a runtime proof of it.
 *
 * `streamText`, not `ToolLoopAgent`. Measured in spike S1 against the real model: `streamText`
 * executed tools, streamed token-by-token, and had the lowest time-to-first-token (1112 ms vs
 * 1873 ms) with no extra abstraction. `ToolLoopAgent.stream()` also returns a Promise that must be
 * awaited before the stream is reachable, which is an easy trip hazard. Do not reintroduce it.
 *
 * Span names to expect, verified in S1 — OTel GenAI convention, NOT `ai.*`:
 * `invoke_agent <model>`, `step N`, `chat <model>`. Anything keying on `ai.streamText` (a v6 name)
 * finds nothing.
 */
import { createOpenAI } from '@ai-sdk/openai';
import { stepCountIs, streamText, tool, type ModelMessage, type Tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { ToolCtx, ToolDef } from '../tools/registry.ts';
import type { TurnMessage, TurnToolCall, TurnUsage } from '../types.ts';
import type { ModelPort, ModelRequest, ModelStreamResult } from './port.ts';

/**
 * A `ToolDef` as the AI SDK's `Tool`.
 *
 * T8 deliberately left this here rather than in `tools/registry.ts`, because the return type comes
 * from `ai`. AI SDK v7's `tool()` takes a Zod schema directly, so `def.input` is passed as-is — do
 * NOT route this through `toJsonSchema()`. That projection exists for TAC (T14) and the console
 * (T19), and it drops `additionalProperties: false`, which OpenAI's strict function calling
 * rejects as a mid-turn 400. See the `toJsonSchema` docblock for the full account.
 */
export function toAiSdkTool(def: ToolDef, ctx: ToolCtx): Tool {
  return tool({
    description: def.description,
    inputSchema: def.input,
    execute: (args: unknown) => def.execute(args, ctx),
  });
}

/**
 * What the tracing integration needs in order to link this call to a Langfuse prompt VERSION,
 * which is what lights up that version's Metrics tab.
 *
 * `isFallback` is optional but PRESERVED when present, and that is the direction that matters:
 * the integration's `normalizePrompt` DEFAULTS it to `false`, so dropping a `true` here would
 * attribute a self-declared fallback to a real prompt version — the one error mode that silently
 * corrupts the numbers rather than losing them. Nothing can hit it today (T7 nulls `telemetryLink`
 * on the fallback, so a fallback link never reaches this function), which is exactly why it is worth
 * pinning now: the next carrier of this value has no reason to know.
 */
const PromptLinkSchema = z.object({
  name: z.string().min(1),
  version: z.number(),
  isFallback: z.boolean().optional(),
});

/**
 * Normalise `ResolvedPrompt.telemetryLink` into the shape `@langfuse/vercel-ai-sdk` recognises.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * THIS IS NOT THE ≤v6 RECIPE, AND THE ≤v6 RECIPE FAILS SILENTLY HERE.
 *
 * On AI SDK ≤6 the link went in `experimental_telemetry.metadata.langfusePrompt` as the raw
 * `prompt.toJSON()` STRING. Both halves of that are wrong on the installed versions
 * (`ai@7.0.93`, `@langfuse/vercel-ai-sdk@5.11`), and neither produces an error:
 *
 *  1. `TelemetryOptions` in ai@7 has NO `metadata` field at all. Observation metadata now comes
 *     from `runtimeContext` keys opted in via `telemetry.includeRuntimeContext`
 *     (`ai/dist/index.js`, `filterIncludedContext` — a key not set to exactly `true` is dropped).
 *  2. The integration reads `runtimeContext.langfusePrompt` and runs it through its own
 *     `normalizePrompt`, which requires a PLAIN OBJECT with `name: string` and `version: number`
 *     (`@langfuse/vercel-ai-sdk/dist/index.mjs`). `ChatPromptClient.toJSON()` returns a
 *     `JSON.stringify(...)` STRING, so it fails `isPlainObject` and the link is dropped — no
 *     warning, no error, just a trace with no prompt attached.
 *
 * Hence: parse the string back, validate, and hand over an object. The symptom of getting this
 * wrong is a prompt version whose Metrics tab stays empty, which reads as a Langfuse problem.
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Returns `undefined` for anything unparseable rather than throwing: a broken link must not be
 * able to end a phone call, and a turn with an unlinked trace is still a working turn.
 */
export function langfusePromptLink(
  link: unknown,
): { name: string; version: number; isFallback?: boolean } | undefined {
  let candidate: unknown = link;
  if (typeof link === 'string') {
    try {
      candidate = JSON.parse(link);
    } catch {
      return undefined;
    }
  }
  const parsed = PromptLinkSchema.safeParse(candidate);
  if (!parsed.success) return undefined;
  const { name, version, isFallback } = parsed.data;
  // Omitted rather than defaulted when absent: `normalizePrompt` supplies `false` itself, and
  // inventing one here would make an unstated fallback indistinguishable from a declared one.
  return { name, version, ...(isFallback !== undefined && { isFallback }) };
}

/**
 * `toolChoice`, but only when there is something to choose from.
 *
 * A prompt version can name nothing but dead tools (T8's `unknown` bucket) while still asking for
 * `toolChoice: 'required'`, and `tool_choice: required` with an empty tool set is an opaque 400 from
 * OpenAI in the MIDDLE of a call — the caller hears the turn die. Returning `{}` omits the key
 * entirely rather than sending `undefined`, which the SDK would forward.
 *
 * Extracted rather than inlined so the guard itself is unit-testable: exercising it through
 * `stream()` would mean a real network call, and asserting the port's INPUTS (what `run-turn.ts`
 * hands over) cannot see what this decides.
 */
export function toolChoiceOption(
  toolCount: number,
  toolChoice: ModelRequest['toolChoice'],
): { toolChoice?: ModelRequest['toolChoice'] } {
  return toolCount > 0 ? { toolChoice } : {};
}

const toModelMessage = (m: TurnMessage): ModelMessage => ({ role: m.role, content: m.content });

const toUsage = (u: {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  totalTokens: number | undefined;
}): TurnUsage => ({
  inputTokens: u.inputTokens ?? null,
  outputTokens: u.outputTokens ?? null,
  totalTokens: u.totalTokens ?? null,
});

export interface OpenAiModelDeps {
  /** From `AppConfig.openai.apiKey`. Taken as a value; this file reads no environment. */
  readonly apiKey: string;
}

export function createOpenAiModelPort(deps: OpenAiModelDeps): ModelPort {
  const provider = createOpenAI({ apiKey: deps.apiKey });

  return {
    stream(request: ModelRequest) {
      const tools: ToolSet = Object.fromEntries(
        request.tools.map((def) => [def.name, toAiSdkTool(def, request.toolCtx)]),
      );
      const promptLink = langfusePromptLink(request.telemetry.promptLink);

      const result = streamText({
        model: provider(request.model),
        system: request.system,
        messages: request.messages.map(toModelMessage),
        // The port's message type permits a `system` role, and a Langfuse chat prompt may hold
        // several. Without this the SDK rejects one with InvalidMessageRoleError mid-turn.
        allowSystemInMessages: true,
        tools,
        // Only when there is something to choose from — see `toolChoiceOption`.
        ...toolChoiceOption(request.tools.length, request.toolChoice),
        stopWhen: stepCountIs(request.maxSteps),
        abortSignal: request.abortSignal,
        ...(request.temperature !== undefined && { temperature: request.temperature }),
        ...(request.maxOutputTokens !== undefined && { maxOutputTokens: request.maxOutputTokens }),
        // `langfusePrompt` is destructured out of runtimeContext by the integration before the rest
        // becomes metadata, so an absent link adds nothing — see langfusePromptLink above.
        runtimeContext: { langfusePrompt: promptLink },
        // Passed explicitly even though ai@7 emits by default once an integration is registered:
        // `functionId` is what separates voice from SMS in Langfuse, and being explicit makes the
        // default non-blocking.
        telemetry: {
          isEnabled: true,
          functionId: request.telemetry.functionId,
          includeRuntimeContext: { langfusePrompt: true },
        },
      });

      // `textStream` is an AsyncIterableStream<string>, so it already satisfies the port. On abort
      // it CLOSES cleanly rather than throwing (ai@7 enqueues an `abort` part and closes), which is
      // why `runTurn` reads `abortSignal.aborted` rather than inspecting an error.
      //
      // `done` is built here, synchronously, so its rejection handlers are attached before any
      // failure can surface. Note the SDK's promise getters call `consumeStream()` on a tee'd copy,
      // so they settle on the MODEL's schedule, independently of whether our consumer has finished
      // draining `tokens` — that is precisely why `runTurn` waits for the stream as well.
      const done: Promise<ModelStreamResult> = Promise.all([
        result.text,
        result.toolCalls,
        result.totalUsage,
        result.steps,
      ]).then(([text, toolCalls, usage, steps]) => ({
        text,
        toolCalls: toolCalls.map((c): TurnToolCall => ({ name: c.toolName, input: c.input })),
        usage: toUsage(usage),
        steps: steps.length,
      }));

      return { tokens: result.textStream, done };
    },
  };
}
