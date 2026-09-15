/**
 * Diagnostic: prove a span from THIS process reaches Langfuse, with the intended shape — and that
 * the VOICE TIMELINE renders as one continuous waterfall for a whole call.
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
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS ALONGSIDE `tests/voice-telemetry.test.ts`, WHICH ASSERTS THE SAME SHAPE.
 *
 * That test registers a `BasicTracerProvider` + `InMemorySpanExporter` and can therefore see every
 * observation our helpers create — but it does NOT register `LangfuseSpanProcessor`, so it cannot
 * see the filtering. The whole failure class `server/obs/spans.ts` warns about is a span that
 * exists, is sampled, is visible to an in-memory exporter, and is silently dropped on the way out.
 * Only a run against a live Langfuse closes that, which is what this script is for.
 *
 * It drives the REAL `createVoiceTimeline`, not a re-implementation of it, so what appears in the UI
 * is what a call produces. Only the instants are synthetic.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
import { getActiveTraceId } from '@langfuse/tracing';
import {
  startConversationSpan,
  withTurnSpan,
  startSpanUnder,
  startStep,
  timeStep,
  flushTelemetry,
  TRACEPARENT_KEY,
} from '../server/obs/spans.ts';
import { createVoiceTimeline } from '../server/obs/voice-timeline.ts';
import { withFirstTokenMark, collect } from '../server/obs/first-token.ts';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Long enough to be unmistakable in the UI: this is the time the old instrumentation lost. */
const CALLER_GAP_MS = 900;
/** Where the third turn is interrupted, measured from its own first token. */
const INTERRUPT_AFTER_MS = 260;

interface Turn {
  readonly utterance: string;
  readonly chunks: readonly string[];
  /** Interrupt this turn after `INTERRUPT_AFTER_MS`, the way a barge-in arrives. */
  readonly interrupted?: true;
}

const TURNS: readonly Turn[] = [
  { utterance: 'where is my order A4721?', chunks: ['Order ', 'A4721 ', 'shipped on Tuesday.'] },
  { utterance: 'and the other one?', chunks: ['The second one ', 'is still being packed.'] },
  {
    utterance: 'actually, cancel both of them',
    chunks: ['Of course — ', 'let me check ', 'whether that is still possible.'],
    interrupted: true,
  },
];

// Stand-in for the model's token stream. The leading sleep is what becomes ttft/ttfa.
async function* fakeTokens(chunks: readonly string[]): AsyncIterable<string> {
  await sleep(120);
  for (const chunk of chunks) {
    yield chunk;
    await sleep(15);
  }
}

// ---- the conversation root: started at voice `setup`, NOT held open ----
const conversation = startConversationSpan('conversation.voice', {
  channel: 'voice',
  from: '+15551234567',
});
if (conversation.traceparent === undefined) {
  console.error('FAIL: no traceparent produced — is LANGFUSE_* set and instrumentation preloaded?');
  process.exit(1);
}
console.log(`traceparent stashed on session.metadata.${TRACEPARENT_KEY}`);
console.log(`  ${conversation.traceparent}`);

// This is what TAC's session.metadata would carry between turns.
const sessionMetadata: Record<string, unknown> = { [TRACEPARENT_KEY]: conversation.traceparent };

/**
 * The REAL timeline, driven the way `server/twilio/voice.ts` drives it. Its `forget()` return value is
 * what the registry's `onClose` hook writes onto the root span in production; here the root is closed
 * by hand, so the same call is made explicitly at the end.
 */
const timeline = createVoiceTimeline();
const CONVERSATION_ID = 'conv_verify_telemetry';

let traceId: string | undefined;
let interruptedTurn: number | null = null;

for (const [index, turn] of TURNS.entries()) {
  // The gap between turns, which is what `caller.turn` exists to make visible.
  if (index > 0) await sleep(CALLER_GAP_MS);

  const promptAt = Date.now();

  await withTurnSpan(
    'turn.voice',
    sessionMetadata[TRACEPARENT_KEY] as string,
    async (span) => {
      traceId ??= getActiveTraceId();

      const priorBotOutputAt = timeline.beginTurn(CONVERSATION_ID, span, promptAt);
      if (priorBotOutputAt !== null) {
        startSpanUnder(
          sessionMetadata[TRACEPARENT_KEY] as string,
          'caller.turn',
          {
            metadata: {
              durationMs: promptAt - priorBotOutputAt,
              covers: 'bot playback + caller speech + ASR endpointing (+ memory recall on turn 1)',
            },
          },
          priorBotOutputAt,
        ).end(promptAt);
      }

      span.event(
        'asr.final',
        { metadata: { transcriptChars: turn.utterance.length, lang: null } },
        promptAt,
      );

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
      const { stream, marks } = withFirstTokenMark(fakeTokens(turn.chunks), () =>
        timeline.markFirstToken(CONVERSATION_ID, Date.now()),
      );
      const text = await collect(stream);

      const tts = startStep('tts.handoff');
      await sleep(6);
      tts.end();

      span.update({
        input: { utterance: turn.utterance },
        output: { text },
        metadata: {
          'turn.index': index,
          'turn.ttft_ms': marks.ttftMs,
          'prompt.version': 1,
          'prompt.label': 'production',
          channel: 'voice',
        },
      });

      if (turn.interrupted === true) {
        /**
         * The barge-in, both halves of it. TAC's `handleInterruptMessage` sends the `{token:'',
         * last:true}` marker ITSELF when tokens had already gone out, and only then invokes the
         * `interrupt` callback — so the boundary is the interrupt receipt and nothing we send.
         */
        await sleep(INTERRUPT_AFTER_MS);
        const interruptAt = Date.now();
        span.event(
          'tts.interrupted',
          {
            metadata: {
              durationUntilInterruptMs: interruptAt - promptAt,
              utteranceUntilInterrupt: turn.chunks[0],
            },
          },
          interruptAt,
        );
        // PARKED, not closed — exactly what `handleVoiceInterrupt` does. Ending the span here costs
        // the turn every attribute the real `run-turn.ts` writes after the stream drains.
        timeline.recordBoundary(CONVERSATION_ID, {
          atMs: interruptAt,
          aborted: true,
          ending: 'interrupt',
        });
        // The prompt handler's `finally`, which has awaited `done` by this point. The parked boundary
        // wins over what is passed here, so the turn still ends at the interrupt.
        timeline.completeTurn(
          CONVERSATION_ID,
          { atMs: Date.now(), aborted: true, ending: 'no-output' },
          span,
        );
        interruptedTurn = index + 1;
        console.log(`turn ${index + 1}: INTERRUPTED after ${interruptAt - promptAt}ms`);
        return;
      }

      timeline.completeTurn(
        CONVERSATION_ID,
        { atMs: Date.now(), aborted: false, ending: 'last-token' },
        span,
      );
      console.log(
        `turn ${index + 1}: ttft=${marks.ttftMs}ms total=${Date.now() - promptAt}ms (prompt-anchored)`,
      );
    },
    // Exactly what the voice handler passes: anchored to `prompt` receipt, ended by the timeline.
    { startTimeMs: promptAt, endOnExit: false },
  );
}

// `forget` returns the statistics AND drops the entry, in that order, because it is what completes a
// turn still live at close time — see its docblock.
const stats = timeline.forget(CONVERSATION_ID);
// In production this merge happens inside the conversation registry's `close`, via the `onClose`
// hook `server/twilio/tac.ts` installs — which is what puts it on all four close paths.
conversation.update({ metadata: { closedBecause: 'ended', ...stats } });
conversation.end();

await flushTelemetry();

const base = process.env.LANGFUSE_BASE_URL ?? 'http://localhost:3100';
const project = process.env.LANGFUSE_INIT_PROJECT_ID ?? 'scaffold';
console.log('\nflushed. Expected ONE trace, continuous from end to end:');
console.log('  conversation.voice        turns.count / turns.aborted / caller.turn_total_ms / ttfa p50+max');
console.log('  ├─ turn.voice  #1         asr.final, prompt.fetch, tools.resolve, tts.handoff, tts.send');
console.log(`  ├─ caller.turn            ~${CALLER_GAP_MS}ms — bot playback + caller speech + ASR endpointing`);
console.log('  ├─ turn.voice  #2         same children');
console.log(`  ├─ caller.turn            ~${CALLER_GAP_MS}ms`);
console.log(
  `  └─ turn.voice  #${interruptedTurn ?? 3}         + tts.interrupted, turn.aborted=true, turn.ending=interrupt`,
);
console.log('\nWhat to check in the UI, in order of what breaks first:');
console.log('  1. ONE trace, not three. A second trace means a span lost its parent context.');
console.log('  2. no gap between a turn.voice ending and the next caller.turn starting.');
console.log('  3. turn.ttfa_ms on every turn, and tts.send ending exactly with its turn.');
console.log('  4. the root carrying turns.count alongside closedBecause, not instead of it.');
if (traceId) console.log(`\n  ${base}/project/${project}/traces?traceId=${traceId}`);
