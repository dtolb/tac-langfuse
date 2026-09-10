/**
 * Time to first token.
 *
 * This lives in its own file, pure and separately tested, because it is the number the whole
 * telemetry design exists to produce: on a voice call, time-to-first-token is the gap between
 * the caller finishing their sentence and the agent starting to speak. It is the difference
 * between a demo that feels alive and one that feels broken.
 *
 * It is measured here rather than read off the AI SDK because "first chunk" is not "first text
 * delta" — when a turn starts with a tool call, the first chunks carry tool input and no audible
 * output follows for hundreds of milliseconds. Measuring the first NON-EMPTY TEXT delta is the
 * only definition that matches what the caller actually experiences.
 *
 * No vendor imports, so it can be unit-tested against a plain async generator.
 */

export interface FirstTokenMarks {
  /** Milliseconds from `startedAt` to the first non-empty text delta. */
  ttftMs: number | null;
  /** Milliseconds from `startedAt` until the stream ended. */
  totalMs: number | null;
  /** Number of non-empty deltas seen. Zero means the model produced no text at all. */
  deltas: number;
  /** Characters streamed, for a rough tokens-per-second sanity check. */
  chars: number;
}

/**
 * Wrap a token stream so it records timings as it is consumed, without altering what the
 * consumer sees.
 *
 * The returned `marks` object is MUTATED as the stream drains — read it after consumption, not
 * before. That is deliberate: it lets the caller start speaking immediately and still attach the
 * final numbers to a span afterwards, without buffering the stream to measure it.
 *
 * @param tokens the stream to observe. Consumed exactly once, like any async iterable.
 * @param onFirstToken called once, with the elapsed ms, at the first non-empty delta.
 * @param now injectable clock, so tests are not timing-dependent.
 */
export function withFirstTokenMark(
  tokens: AsyncIterable<string>,
  onFirstToken?: (elapsedMs: number) => void,
  now: () => number = () => Date.now(),
): { stream: AsyncIterable<string>; marks: FirstTokenMarks } {
  const marks: FirstTokenMarks = { ttftMs: null, totalMs: null, deltas: 0, chars: 0 };
  const startedAt = now();

  async function* observed(): AsyncIterable<string> {
    try {
      for await (const delta of tokens) {
        if (delta.length > 0) {
          if (marks.ttftMs === null) {
            marks.ttftMs = now() - startedAt;
            onFirstToken?.(marks.ttftMs);
          }
          marks.deltas++;
          marks.chars += delta.length;
        }
        yield delta;
      }
    } finally {
      // `finally` rather than after the loop: an aborted turn (barge-in) is the interesting
      // case, and we still want its partial timings recorded rather than lost.
      marks.totalMs = now() - startedAt;
    }
  }

  return { stream: observed(), marks };
}

/** Collect a stream into one string. For SMS, where there is nothing to stream to. */
export async function collect(tokens: AsyncIterable<string>): Promise<string> {
  let out = '';
  for await (const delta of tokens) out += delta;
  return out;
}
