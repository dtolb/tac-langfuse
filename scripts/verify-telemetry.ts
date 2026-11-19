/**
 * Diagnostic: prove a voice call's spans from THIS process reach Langfuse with the intended shape,
 * then read the trace back and check it.
 *
 *   node --import ./server/obs/instrumentation.ts --env-file-if-exists=.env scripts/verify-telemetry.ts
 *
 * Drives the real registry, timeline and span helpers the voice channel uses, with synthetic
 * instants and no model call, then checks through `GET /api/public/v2/observations`:
 *
 *  - one trace: `conversation.voice` > 3 × `turn.voice`, 2 × `caller.turn`, `tts.interrupted`, plus a
 *    `prompt.fetch` on turn 1 only, and the backdated `twilio.*` span and event drawn after the root ended;
 *  - every observation carries the session id and the profile as user id;
 *  - the root is the only root observation, including the spans drawn after it ended;
 *  - turn and root input/output are the words, and the root carries the channel, prompt and
 *    `cr.config.revision` tags.
 *
 * Exits non-zero on the first failed check.
 */
import { randomUUID } from 'node:crypto';
import { turnSpans } from '../server/agent/spans.ts';
import { createConversationRegistry } from '../server/obs/conversations.ts';
import {
  annotateTrace,
  drawUnder,
  eventUnder,
  flushTelemetry,
  rootContextFor,
  startSpanUnder,
  withTurnSpan,
} from '../server/obs/spans.ts';
import { createVoiceTimeline } from '../server/obs/voice-timeline.ts';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const run = randomUUID().slice(0, 8);
const CONVERSATION_ID = `verify-telemetry-${run}`;
const CALL_SID = `CAverify${run}`;
const PROFILE_ID = `mem_profile_verify_${run}`;
const CALLER_GAP_MS = 900;

const TURNS = [
  { utterance: 'where is my order A4721?', reply: 'Order A4721 shipped on Tuesday.' },
  { utterance: 'and the other one?', reply: 'The second one is still being packed.' },
  { utterance: 'actually, cancel both of them', reply: 'Of course — let me check', interrupted: true },
] as const;

const timeline = createVoiceTimeline();
const conversations = createConversationRegistry({
  spanName: 'conversation.voice',
  onClose: (id) => timeline.forget(id),
  aliasOf: () => CALL_SID,
});

const traceparent = conversations.traceparentFor(CONVERSATION_ID);
if (traceparent === undefined) {
  console.error('FAIL: no traceparent produced — is LANGFUSE_* set and instrumentation preloaded?');
  process.exit(1);
}
const traceId = traceparent.split('-')[1] as string;
const startedAt = new Date(Date.now() - 60_000).toISOString();

for (const [index, turn] of TURNS.entries()) {
  if (index > 0) await sleep(CALLER_GAP_MS);
  const promptAt = Date.now();

  await withTurnSpan(
    'turn.voice',
    traceparent,
    async (span) => {
      const priorBotOutputAt = timeline.beginTurn(CONVERSATION_ID, span, promptAt);
      if (priorBotOutputAt !== null) {
        startSpanUnder(traceparent, 'caller.turn', { metadata: { durationMs: promptAt - priorBotOutputAt } }, priorBotOutputAt).end(promptAt);
      }
      span.update({ input: turn.utterance, metadata: { 'asr.transcript_chars': turn.utterance.length, 'cr.config.revision': 3 } });
      turnSpans.annotate({ userId: PROFILE_ID, input: turn.utterance, tags: ['prompt:demo-agent-voice@v1', 'cr.config.revision:3'] });
      if (index === 0) turnSpans.record('prompt.fetch', { output: { name: 'demo-agent-voice', version: 1 } }, promptAt, promptAt + 40);

      await sleep(120);
      timeline.markFirstToken(CONVERSATION_ID, Date.now(), span);
      await sleep(80);
      span.update({ output: turn.reply });
      annotateTrace({ output: turn.reply });

      if ('interrupted' in turn) {
        const interruptAt = Date.now();
        span.event('tts.interrupted', { metadata: { utteranceUntilInterrupt: turn.reply } }, interruptAt);
        timeline.recordBoundary(CONVERSATION_ID, { atMs: interruptAt, aborted: true, ending: 'interrupt' });
      }
      timeline.completeTurn(CONVERSATION_ID, { atMs: Date.now(), aborted: false, ending: 'last-token' }, span);
    },
    { startTimeMs: promptAt, endOnExit: false },
  );
}

conversations.end(CONVERSATION_ID);

const root = rootContextFor(CALL_SID);
if (root === undefined) {
  console.error('FAIL: rootContextFor(CallSid) found nothing after the call ended');
  process.exit(1);
}
const lateAt = Date.now() + 1_000;
drawUnder(root.traceparent, 'twilio.stt', { metadata: { latency_ms: 300 } }, lateAt - 300, lateAt);
eventUnder(root.traceparent, 'twilio.call_wrap_up', { metadata: {} }, lateAt);
await flushTelemetry();
console.log(`trace ${traceId}, session ${CONVERSATION_ID}; flushed, reading back…`);

interface Observation {
  readonly id: string;
  readonly traceId: string;
  readonly name: string;
  readonly parentObservationId: string | null;
  readonly sessionId?: string | null;
  readonly userId?: string | null;
  readonly isRootObservation?: boolean;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly tags?: string[];
  readonly traceName?: string | null;
}

const base = process.env.LANGFUSE_BASE_URL ?? 'https://us.cloud.langfuse.com';
const auth = Buffer.from(`${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`).toString('base64');

const readTrace = async (): Promise<Observation[]> => {
  const out: Observation[] = [];
  let cursor: string | undefined;
  do {
    const url = new URL('/api/public/v2/observations', base);
    url.searchParams.set('traceId', traceId);
    url.searchParams.set('fromStartTime', startedAt);
    url.searchParams.set('fields', 'core,basic,io,trace_context,metadata');
    url.searchParams.set('limit', '100');
    if (cursor !== undefined) url.searchParams.set('cursor', cursor);
    const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
    if (!res.ok) throw new Error(`v2/observations ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { data: Observation[]; meta?: { cursor?: string | null } };
    out.push(...body.data);
    cursor = body.meta?.cursor ?? undefined;
  } while (cursor !== undefined);
  return out.filter((o) => o.traceId === traceId);
};

const EXPECTED: Record<string, number> = {
  'conversation.voice': 1,
  'turn.voice': 3,
  'caller.turn': 2,
  'prompt.fetch': 1,
  'tts.interrupted': 1,
  'twilio.stt': 1,
  'twilio.call_wrap_up': 1,
};
const expectedTotal = Object.values(EXPECTED).reduce((a, b) => a + b, 0);

let observations: Observation[] = [];
for (let attempt = 0; attempt < 30; attempt += 1) {
  observations = await readTrace();
  if (observations.length >= expectedTotal) break;
  await sleep(3_000);
}

const failures: string[] = [];
const check = (ok: boolean, what: string): void => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

const counts: Record<string, number> = {};
for (const o of observations) counts[o.name] = (counts[o.name] ?? 0) + 1;
check(JSON.stringify(counts, Object.keys(EXPECTED).sort()) === JSON.stringify(EXPECTED, Object.keys(EXPECTED).sort()), `observation names ${JSON.stringify(counts)}`);
check(observations.every((o) => o.sessionId === CONVERSATION_ID), 'every observation has the session id');
check(observations.every((o) => o.userId === PROFILE_ID), 'every observation has the profile as user id');
const roots = observations.filter((o) => o.isRootObservation === true);
check(roots.length === 1 && roots[0]?.name === 'conversation.voice', `one root observation (${roots.map((r) => r.name).join(', ')})`);
const rootObs = observations.find((o) => o.name === 'conversation.voice');
const late = observations.filter((o) => o.name.startsWith('twilio.'));
check(late.every((o) => o.parentObservationId === rootObs?.id), 'backdated twilio.* observations hang off the ended root');
check(rootObs?.input === TURNS[0].utterance, `root input is the first utterance (${JSON.stringify(rootObs?.input)})`);
check(rootObs?.output === TURNS[2].reply, `root output is the last reply (${JSON.stringify(rootObs?.output)})`);
const firstTurn = observations.find((o) => o.name === 'turn.voice' && o.input === TURNS[0].utterance);
check(firstTurn?.output === TURNS[0].reply, 'turn.voice input/output are the words');
const tags = new Set(rootObs?.tags ?? []);
check(['channel:voice', 'prompt:demo-agent-voice@v1', 'cr.config.revision:3'].every((t) => tags.has(t)), `root tags ${JSON.stringify([...tags])}`);

console.log(`\n  ${base}/trace/${traceId}`);
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
