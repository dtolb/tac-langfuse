/**
 * Diagnostic: drive ONE real turn end to end and exit non-zero if anything about it is wrong.
 *
 *   node --import ./server/obs/instrumentation.ts --env-file-if-exists=.env scripts/verify-turn.ts
 *
 * The `--import` preamble is load-bearing and is the easiest thing here to leave off. Without it
 * nothing registers `LangfuseSpanProcessor` or the AI SDK telemetry integration, the turn still runs
 * perfectly, and NOT ONE SPAN reaches Langfuse — with no error anywhere. `pnpm verify:turn` carries
 * it for you.
 *
 * Real everything: the prompt comes from the live local Langfuse by label, the tools are the shipped
 * catalog, the model call goes to OpenAI with the key from `.env`. The question deliberately needs
 * BOTH demo tools, so the multi-step loop is genuinely exercised rather than a single chat step.
 *
 * The caller-owns-the-turn-span contract is demonstrated here rather than described: `withTurnSpan`
 * wraps the whole handler INCLUDING the drain of `tokens` and the await on `done`. Shrink that
 * callback to just the `runTurn(...)` call and the waterfall shows the model call outside its own
 * turn, which reads as broken tracing rather than as misuse.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: read the trace back. Langfuse v4 runs in `events_only` mode —
 * `/api/public/traces`, `/observations` and `/metrics/daily` all 404, and `/events`/`/spans` are
 * POST-only. The waterfall is checked by eye in the Langfuse UI. All this script owes Langfuse is a
 * `flushTelemetry()` before the process exits, or the spans never leave.
 *
 * Reading the output: pino batches its writes while `console.log` is synchronous, so a WARN or DEBUG
 * line can land after the block it belongs to. Same caveat as `verify-tools.ts`.
 */
import { CHANNEL_PROMPT } from '../server/agent/prompt/defaults.ts';
import { createLangfusePromptPort } from '../server/agent/prompt/langfuse.ts';
import { promptCacheTtlMs } from '../server/agent/prompt/port.ts';
import { createOpenAiModelPort } from '../server/agent/model/openai.ts';
import { passthroughMemory } from '../server/agent/memory.ts';
import { runTurn } from '../server/agent/run-turn.ts';
import { turnSpans } from '../server/agent/spans.ts';
import { resolve } from '../server/agent/tools/resolve.ts';
import type { TurnChannel, TurnDeps } from '../server/agent/types.ts';
import { capabilities, loadConfig } from '../server/config.ts';
import { createObsBus } from '../server/obs/bus.ts';
import {
  flushTelemetry,
  startConversationSpan,
  withTurnSpan,
  TRACEPARENT_KEY,
} from '../server/obs/spans.ts';

const CHANNEL: TurnChannel = 'bench';
const QUESTION =
  'Where is my order A4721, and what are the opening hours of your Downtown store? Please check both.';

let failures = 0;
const fail = (msg: string): void => {
  failures += 1;
  process.exitCode = 1;
  console.error(`  FAIL  ${msg}`);
};

const app = loadConfig(process.env);
console.log(`langfuse config: ${app.langfuse === null ? 'ABSENT' : app.langfuse.baseUrl}`);
console.log(`openai key:      ${app.openai === null ? 'ABSENT' : 'present'}`);

if (app.openai === null) {
  console.error('\nOPENAI_API_KEY is not set, so there is no turn to verify. Nothing else was run.');
  process.exit(1);
}

const bus = createObsBus();
bus.subscribe((e) =>
  console.log(
    `  obs  ${e.kind.padEnd(16)} ${e.summary}${e.durationMs === undefined ? '' : `  (${e.durationMs}ms)`}`,
  ),
);

const caps = capabilities(app);
const deps: TurnDeps = {
  prompts: createLangfusePromptPort({
    langfuse: app.langfuse,
    bus,
    // The port takes its TTL rather than reading NODE_ENV; `promptCacheTtlMs` is the documented
    // policy and the caller applies it. This script is a caller.
    ttlMs: promptCacheTtlMs(process.env.NODE_ENV),
  }),
  // T8's resolver with its process-wide arguments applied. `capabilities` comes from config, which
  // is why `server/agent/` never reads the environment itself.
  tools: (names, turn) =>
    resolve(names, {
      capabilities: caps,
      bus,
      conversationId: turn.conversationId,
      channel: turn.channel,
    }),
  model: createOpenAiModelPort({ apiKey: app.openai.apiKey }),
  composeMemory: passthroughMemory,
  obs: bus,
  spans: turnSpans,
  branding: { persona: 'Ada, a customer support agent', companyName: 'Northwind Traders' },
};

const conversationId = `verify-turn-${Date.now()}`;
// The conversation root, serialised to a traceparent immediately — the cross-turn carrier a voice
// call has to use, since TAC persists nothing itself and there is no async context to hold open.
const conversation = startConversationSpan(`conversation.${CHANNEL}`, { conversationId });
const sessionMetadata: Record<string, unknown> = {
  [TRACEPARENT_KEY]: conversation.traceparent,
};
console.log(`traceparent:     ${conversation.traceparent ?? 'NONE (no provider registered)'}\n`);
console.log(`prompt for ${CHANNEL}: ${CHANNEL_PROMPT[CHANNEL]}`);
console.log(`question:        ${QUESTION}\n`);

try {
  const result = await withTurnSpan(`turn.${CHANNEL}`, conversation.traceparent, async (span) => {
    const { tokens, done } = await runTurn(
      {
        conversationId,
        channel: CHANNEL,
        userText: QUESTION,
        memory: null,
        sessionMetadata,
        profileId: null,
        abortSignal: new AbortController().signal,
        span,
      },
      deps,
    );

    // Streamed as it arrives rather than collected, because that is what voice does and it is the
    // only way the printed text and the reported TTFT describe the same event.
    process.stdout.write('\n  streamed: ');
    for await (const delta of tokens) process.stdout.write(delta);
    process.stdout.write('\n\n');

    return await done;
  });

  console.log(`  prompt         ${result.prompt.name} ${result.prompt.version === 'fallback' ? 'fallback' : `v${result.prompt.version}`} (label ${result.prompt.label ?? 'none'})`);
  console.log(`  model          ${result.model}`);
  console.log(`  steps          ${result.steps}`);
  console.log(`  tools called   ${result.toolCalls.length === 0 ? '(none)' : result.toolCalls.map((c) => `${c.name}(${JSON.stringify(c.input)})`).join(', ')}`);
  console.log(`  ttftMs         ${result.ttftMs ?? 'null'}`);
  console.log(`  totalMs        ${result.totalMs ?? 'null'}`);
  console.log(`  aborted        ${result.aborted}`);
  console.log(`  usage          in ${result.usage.inputTokens ?? '?'} / out ${result.usage.outputTokens ?? '?'} / total ${result.usage.totalTokens ?? '?'}`);
  console.log(`  text           ${result.text.length} chars`);

  if (result.prompt.version === 'fallback') {
    // NOT a failure: the compiled default is the designed answer when Langfuse is unreachable, and
    // the scaffold has to run on a bare laptop. But say plainly that the live half did not happen.
    console.log('  note: served from the compiled fallback, so nothing here exercised live Langfuse');
  }
  if (result.text.trim() === '') fail('the model produced no text — a caller would hear silence');
  if (result.ttftMs === null) fail('no ttftMs: the stream never yielded a non-empty text delta');
  if (result.totalMs === null) fail('no totalMs: `done` read the marks before the stream had drained');
  if (result.aborted) fail('the turn reported itself aborted, but nothing aborted it');
  if (result.toolCalls.length === 0) {
    fail('no tool was called, so the multi-step path was not exercised — check the prompt version still names both demo tools');
  }
  if (result.steps < 2) {
    fail(`the tool loop took ${result.steps} step(s); a turn that called a tool and then answered takes at least 2`);
  }
} catch (err) {
  fail(`the turn threw: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  conversation.end();
  // Without this the last turn of the run — the one being asked about — never reaches Langfuse.
  // Must go through the provider's delegate; see `flushTelemetry`'s docblock for why the obvious
  // spelling is a silent no-op.
  await flushTelemetry();
}

console.log(
  failures === 0
    ? '\nall checks passed — now confirm the waterfall in the Langfuse UI:\n  conversation.bench > turn.bench > {prompt.fetch, memory.recall, prompt.compose, tools.resolve, llm.stream > invoke_agent}'
    : `\n${failures} check(s) FAILED — see the FAIL lines above (exit 1)`,
);
