/**
 * Diagnostic: prove a span from THIS process reaches Langfuse, with the intended shape.
 *
 *   node --import ./server/obs/instrumentation.ts --env-file-if-exists=.env scripts/verify-telemetry.ts
 *
 * Kept alongside verify-model.mjs because the failure mode it guards against is silent: with a
 * raw OpenTelemetry tracer the spans are created, sampled, and then dropped by
 * LangfuseSpanProcessor's filters, so the code looks fine and Langfuse just looks empty.
 *
 * Exercises the real helpers, including the traceparent round-trip that carries a trace across
 * turns via session.metadata — the part that cannot be unit-tested because it depends on the
 * live processor.
 */
import { getActiveTraceId } from '@langfuse/tracing';
import {
  startConversationSpan,
  withTurnSpan,
  startStep,
  timeStep,
  flushTelemetry,
  TRACEPARENT_KEY,
} from '../server/obs/spans.ts';
import { withFirstTokenMark, collect } from '../server/obs/first-token.ts';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Stand-in for the model's token stream.
async function* fakeTokens(): AsyncIterable<string> {
  await sleep(120); // the gap that becomes ttft
  for (const chunk of ['Refunds ', 'take two ', 'business days.']) {
    yield chunk;
    await sleep(15);
  }
}

// ---- the conversation root: started at voice `setup`, NOT held open ----
const conversation = startConversationSpan('conversation', { channel: 'voice', from: '+15551234567' });
if (conversation.traceparent === undefined) {
  console.error('FAIL: no traceparent produced — is LANGFUSE_* set and instrumentation preloaded?');
  process.exit(1);
}
console.log(`traceparent stashed on session.metadata.${TRACEPARENT_KEY}`);
console.log(`  ${conversation.traceparent}`);

// This is what TAC's session.metadata would carry between turns.
const sessionMetadata: Record<string, unknown> = { [TRACEPARENT_KEY]: conversation.traceparent };

let traceId: string | undefined;

// ---- two turns, each rehydrating from the stashed traceparent ----
for (const [index, utterance] of ['how long do refunds take?', 'and for digital orders?'].entries()) {
  await withTurnSpan('turn.voice', sessionMetadata[TRACEPARENT_KEY] as string, async (turn) => {
    traceId ??= getActiveTraceId();

    await timeStep('prompt.fetch', async () => {
      await sleep(8);
      return { version: 1, label: 'production', cached: true };
    }, (r) => r);

    await timeStep('tools.resolve', async () => {
      await sleep(3);
      // Real catalog names (`server/agent/tools/catalog.ts`), so the fixture does not teach a
      // catalog that does not exist. `handoff` is a stand-in for a T14 TAC built-in rather than a
      // catalog tool, kept so the unavailable bucket is non-empty in the span attributes.
      return { resolved: ['lookup_order'], unknown: [], unavailable: ['handoff'] };
    }, (r) => r);

    // The model call would go here. In the real turn this is where the AI SDK's own spans
    // (`invoke_agent`, `step N`, `chat <model>`) nest automatically off the ambient context.
    const { stream, marks } = withFirstTokenMark(fakeTokens());
    const text = await collect(stream);

    const tts = startStep('tts.handoff');
    await sleep(6);
    tts.end();

    turn.update({
      input: { utterance },
      output: { text },
      metadata: {
        'turn.index': index,
        'turn.ttft_ms': marks.ttftMs,
        'turn.total_ms': marks.totalMs,
        'prompt.version': 1,
        'prompt.label': 'production',
        channel: 'voice',
      },
    });
    console.log(`turn ${index + 1}: ttft=${marks.ttftMs}ms total=${marks.totalMs}ms`);
  });
}

conversation.update({ output: { turns: 2 } });
conversation.end();

await flushTelemetry();

const base = process.env.LANGFUSE_BASE_URL ?? 'http://localhost:3100';
const project = process.env.LANGFUSE_INIT_PROJECT_ID ?? 'scaffold';
console.log('\nflushed. Expected ONE trace containing BOTH turns:');
console.log('  conversation');
console.log('  └─ turn.voice  x2   (prompt.fetch, tools.resolve, tts.handoff each)');
if (traceId) console.log(`\n  ${base}/project/${project}/traces?traceId=${traceId}`);
