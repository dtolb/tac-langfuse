import { test, expect } from 'vitest';
import { withFirstTokenMark, collect } from '../server/obs/first-token.ts';

/**
 * A fake clock, so these assertions are exact rather than timing-dependent. A TTFT test that
 * tolerates ±50ms cannot detect the bug it exists to catch (measuring the wrong chunk).
 */
const clock = (steps: number[]) => {
  let i = 0;
  return () => steps[Math.min(i++, steps.length - 1)] ?? 0;
};

/**
 * now() is called EXACTLY three times per stream: once for startedAt, once at the first
 * non-empty delta, once in the finally block. Not once per delta — getting this wrong is how the
 * first draft of these tests failed.
 */
const clock3 = (start: number, firstToken: number, end: number) => clock([start, firstToken, end]);

async function* gen(...values: string[]): AsyncIterable<string> {
  for (const v of values) yield v;
}

test('ttft is the first NON-EMPTY delta, not the first chunk', () => {
  // THE case this file exists for. When a turn opens with a tool call, the early chunks carry
  // tool input and no audible output follows for hundreds of ms. Counting the first chunk would
  // report a flatteringly small number that the caller never experiences.
  return (async () => {
    const { stream, marks } = withFirstTokenMark(gen('', '', 'Hi', ' there'), undefined, clock3(0, 250, 400));
    await collect(stream);
    expect(marks.ttftMs).toBe(250);
    expect(marks.deltas).toBe(2); // only the non-empty ones
    expect(marks.chars).toBe(8);
  })();
});

test('onFirstToken fires exactly once', async () => {
  const calls: number[] = [];
  const { stream } = withFirstTokenMark(gen('a', 'b', 'c'), (ms) => calls.push(ms), clock3(0, 5, 8));
  await collect(stream);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toBe(5);
});

test('the observed stream yields exactly what it was given', async () => {
  // Observation must be invisible to the consumer, including empty deltas — dropping those would
  // change what a downstream text accumulator sees.
  const { stream } = withFirstTokenMark(gen('a', '', 'b'));
  const seen: string[] = [];
  for await (const d of stream) seen.push(d);
  expect(seen).toEqual(['a', '', 'b']);
});

test('totalMs is recorded when the stream ends', async () => {
  const { stream, marks } = withFirstTokenMark(gen('a', 'b'), undefined, clock3(0, 10, 99));
  await collect(stream);
  expect(marks.totalMs).toBe(99);
});

test('a stream with no text reports null ttft rather than zero', async () => {
  // Zero would read as "instant", which is the opposite of the truth — the model said nothing.
  const { stream, marks } = withFirstTokenMark(gen('', ''));
  await collect(stream);
  expect(marks.ttftMs).toBeNull();
  expect(marks.deltas).toBe(0);
});

test('an aborted turn still records its partial timings', async () => {
  // Barge-in is the interesting case on voice: the caller interrupted, and how long the agent had
  // been talking is exactly what you want to know. Breaking out of the loop must not lose it.
  const { stream, marks } = withFirstTokenMark(gen('one', 'two', 'three'), undefined, clock3(0, 7, 50));
  for await (const d of stream) {
    if (d === 'two') break; // simulate an interrupt mid-stream
  }
  expect(marks.ttftMs).toBe(7);
  expect(marks.totalMs).not.toBeNull(); // the `finally` fired
});

test('marks are readable after consumption, and mutate during it', async () => {
  const { stream, marks } = withFirstTokenMark(gen('a', 'b'), undefined, clock3(0, 3, 5));
  expect(marks.ttftMs).toBeNull(); // nothing consumed yet
  await collect(stream);
  expect(marks.ttftMs).toBe(3);
});

test('an error mid-stream still records timings and propagates', async () => {
  async function* boom(): AsyncIterable<string> {
    yield 'partial';
    throw new Error('model died');
  }
  const { stream, marks } = withFirstTokenMark(boom(), undefined, clock3(0, 12, 40));
  await expect(collect(stream)).rejects.toThrow('model died');
  expect(marks.ttftMs).toBe(12);
  expect(marks.totalMs).not.toBeNull();
});

test('collect concatenates in order', async () => {
  expect(await collect(gen('a', 'b', 'c'))).toBe('abc');
});
