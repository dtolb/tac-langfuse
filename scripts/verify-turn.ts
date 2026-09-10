/**
 * Diagnostic: drive THREE real turns of one conversation and exit non-zero if anything is wrong.
 *
 * Turn 1 exercises the multi-step tool loop. Turn 2 asks something answerable ONLY from turn 1, which
 * is the single check in this repo that an amnesiac agent cannot pass — every other assertion here is
 * satisfied just as well with no history at all. Turn 3 repeats turn 2 after `clear()` and requires
 * the answer to have gone away.
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
import { createHistory } from '../server/agent/history.ts';
import { CHANNEL_PROMPT } from '../server/agent/prompt/defaults.ts';
import { createLangfusePromptPort } from '../server/agent/prompt/langfuse.ts';
import { promptCacheTtlMs } from '../server/agent/prompt/port.ts';
import { createOpenAiModelPort } from '../server/agent/model/openai.ts';
import { passthroughMemory } from '../server/agent/memory.ts';
import { runTurn } from '../server/agent/run-turn.ts';
import { turnSpans } from '../server/agent/spans.ts';
import { resolve } from '../server/agent/tools/resolve.ts';
import type { TurnChannel, TurnDeps, TurnResult } from '../server/agent/types.ts';
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
/**
 * Turn 2 is answerable ONLY from history — the order number appears nowhere in this sentence, in the
 * system prompt or in any tool output, so a correct answer is proof the store worked. An amnesiac
 * agent answers this fluently and wrongly ("could you tell me the order number?"), which is exactly
 * why a single-turn check cannot see the defect.
 */
const FOLLOW_UP = 'What was the order number I just asked about? Reply with only the number.';
/** The string turn 2 must contain and post-clear turn 3 must not. Specific enough that a guess is not a plausible explanation. */
const ORDER_NUMBER = 'A4721';

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
// The real store with its shipped caps. Held here rather than inside `deps` so this script can also
// assert the thing no single turn can show: that `clear` actually detaches the transcript.
const history = createHistory();
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
  history,
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

/**
 * One turn, driven the way a real caller does.
 *
 * Every turn of the run goes through here and through the SAME `conversation.traceparent`, so turns
 * 1-3 land in one Langfuse trace — which is also the shape T13 needs on a live call.
 *
 * The `withTurnSpan` callback wraps the drain AND the `await done`, which is the contract from
 * `run-turn.ts`'s header. Note there is no `await` between receiving `tokens` and the first
 * iteration: that is the other half of the contract, and getting it wrong reports null timings while
 * still printing the whole answer correctly.
 */
const driveTurn = async (question: string): Promise<TurnResult> =>
  withTurnSpan(`turn.${CHANNEL}`, conversation.traceparent, async (span) => {
    const { tokens, done } = await runTurn(
      {
        conversationId,
        channel: CHANNEL,
        userText: question,
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

try {
  const result = await driveTurn(QUESTION);

  console.log(`  prompt         ${result.prompt.name} ${result.prompt.version === 'fallback' ? 'fallback' : `v${result.prompt.version}`} (label ${result.prompt.label ?? 'none'})`);
  console.log(`  model          ${result.model}`);
  console.log(`  steps          ${result.steps}`);
  console.log(`  tools called   ${result.toolCalls.length === 0 ? '(none)' : result.toolCalls.map((c) => `${c.name}(${JSON.stringify(c.input)})`).join(', ')}`);
  // BOTH TTFTs, because the gap between them is the point: `ttftMs` is measured from the start of the
  // turn (so it includes the prompt fetch, recall, compose and resolve that sit in front of the first
  // spoken word) and `modelTtftMs` from the model call alone. Only the second is comparable with the
  // AI SDK's own numbers; only the first is close to what the caller waited through.
  console.log(`  ttftMs         ${result.ttftMs ?? 'null'}  (from turn start — what the caller waits)`);
  console.log(`  modelTtftMs    ${result.modelTtftMs ?? 'null'}  (from the model call alone)`);
  console.log(
    `  preambleMs     ${result.ttftMs === null || result.modelTtftMs === null ? 'n/a' : result.ttftMs - result.modelTtftMs}  (prompt fetch + recall + compose + resolve)`,
  );
  // Same pairing as the two TTFTs above and for the same reason: `totalMs` is on the TURN origin, so
  // `ttftMs <= totalMs` is readable as a sanity check, and `modelTotalMs` is the stream's own duration.
  console.log(`  totalMs        ${result.totalMs ?? 'null'}  (from turn start — first token to last)`);
  console.log(`  modelTotalMs   ${result.modelTotalMs ?? 'null'}  (the stream's own duration)`);
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
  // The `model*` twins come from the same `marks` object, so they are null together with the two above
  // — checked anyway rather than merely printed, because "printed but unchecked" is how a null that
  // ISN'T shared would slip through a green run.
  if (result.modelTtftMs === null) fail('no modelTtftMs: the stream never yielded a non-empty text delta');
  if (result.totalMs === null) fail('no totalMs: `done` read the marks before the stream had drained');
  if (result.modelTotalMs === null) fail('no modelTotalMs: `done` read the marks before the stream had drained');
  if (result.ttftMs !== null && result.totalMs !== null && result.ttftMs > result.totalMs) {
    // Both are on the turn origin, so this cannot happen by construction. Asserted on a live turn
    // anyway: it is the invariant that was violated on the two-origin version, and the symptom there
    // was a console timeline reading "first token at 500ms, response complete at 360ms".
    fail(`ttftMs ${result.ttftMs} > totalMs ${result.totalMs}: the timings are on different origins again`);
  }
  if (result.aborted) fail('the turn reported itself aborted, but nothing aborted it');
  if (result.toolCalls.length === 0) {
    fail('no tool was called, so the multi-step path was not exercised — check the prompt version still names both demo tools');
  }
  if (result.steps < 2) {
    fail(`the tool loop took ${result.steps} step(s); a turn that called a tool and then answered takes at least 2`);
  }

  // ---- turn 2: does the agent actually remember? ----
  // The check T10 exists for, and the only one in this repo that a real model has to pass. Everything
  // above this line is satisfied just as well by an agent with no memory at all.
  const stored = history.read(conversationId);
  console.log(`\n  history        ${stored.length} message(s) after turn 1: ${stored.map((m) => m.role).join(', ')}`);
  if (stored.length !== 2) {
    fail(`expected the user+assistant pair in history after one turn, found ${stored.length} message(s)`);
  }

  console.log(`\nturn 2 — answerable ONLY from history\nquestion:        ${FOLLOW_UP}`);
  const second = await driveTurn(FOLLOW_UP);
  console.log(`  ttftMs         ${second.ttftMs ?? 'null'}`);
  console.log(`  historyIn      ${stored.length} message(s) were sent as prior context`);
  console.log(`  text           ${second.text.trim()}`);

  if (second.text.includes(ORDER_NUMBER)) {
    console.log(`  ok: the model repeated ${ORDER_NUMBER}, which appears nowhere in turn 2's question`);
  } else {
    fail(
      `turn 2 did not repeat ${ORDER_NUMBER} — the agent did not see turn 1. This is the amnesiac failure T10 exists to prevent, and it passes every single-turn check above.`,
    );
  }
  if (history.read(conversationId).length !== 4) {
    fail(`expected 4 messages after two turns, found ${history.read(conversationId).length}`);
  }

  // ---- turn 3: and does `clear` really detach it? ----
  // T13 calls `clear` from `conversationEnded` and `webSocketDisconnected`. A `clear` that forgot the
  // id but left the transcript reachable would leak one caller's conversation into the next call on a
  // reused id, which is a privacy failure rather than a bug.
  history.clear(conversationId);
  console.log(`\nturn 3 — the same question after clear()\n  history        ${history.read(conversationId).length} message(s)`);
  if (history.read(conversationId).length !== 0) fail('clear() did not empty the conversation');

  const third = await driveTurn(FOLLOW_UP);
  console.log(`  text           ${third.text.trim()}`);
  if (third.text.includes(ORDER_NUMBER)) {
    fail(`turn 3 repeated ${ORDER_NUMBER} after clear() — the transcript is still reachable`);
  } else {
    console.log(`  ok: no ${ORDER_NUMBER} — a cleared conversation genuinely starts over`);
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
