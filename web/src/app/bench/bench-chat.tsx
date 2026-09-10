'use client';

/**
 * The bench conversation — the first place a human talks to this agent.
 *
 * A CLIENT island, deliberately small: it owns the transcript, the conversation id and the fetch. The
 * page around it stays a server component.
 *
 * WHY `fetch` AND NOT `EventSource`. `EventSource` is GET-only, and the alternative — putting the
 * utterance in a query string — writes what a customer typed into every access log between here and
 * the agent, defeating the PII scrubbing the server does deliberately. So the turn is a POST whose
 * response is an SSE stream, read here with a `ReadableStream` reader.
 *
 * The path is RELATIVE on purpose. In production Traefik routes `/api` to the agent container on this
 * same host; in development `next.config.ts` rewrites it. Either way this line does not change.
 */

import { useCallback, useRef, useState, type ReactNode } from 'react';
import { ChatLog } from '@gtmi/strix-react/atoms/chat-log';
import { ChatInput } from '@gtmi/strix-react/atoms/chat-input';
import { Badge } from '@gtmi/strix-react/atoms/badge';
import { Typography } from '@gtmi/strix-react/atoms/typography';
import { BENCH_TURN_PATH } from '../../../../shared/twilio-paths.ts';

/** What the server sends on `done`. Mirrors the object built in `server/http/routes-bench.ts`. */
interface DoneFrame {
  readonly text: string;
  readonly toolCalls: readonly string[];
  readonly steps: number;
  readonly ttftMs: number | null;
  readonly totalMs: number | null;
  readonly aborted: boolean;
  readonly prompt: { readonly name: string; readonly version: number | 'fallback'; readonly label: string | null };
  readonly model: string;
}

/**
 * `ChatLog`'s entry union, narrowed to the three shapes this page builds.
 *
 * Taken from the component's own manifest rather than guessed: `message` needs `author` and `text`,
 * `event` needs a `variant` from a closed set. A wrong shape here is a type error, which is the one
 * kind of Strix mistake that fails loudly.
 */
type Entry =
  | { id: string; type: 'message'; author: string; text: string; side?: 'start' | 'end'; authorColor?: 'default' | 'accent' | 'success' | 'error' }
  | { id: string; type: 'event'; variant: 'info' | 'success' | 'warning' | 'error' | 'response'; text: string }
  | { id: string; type: 'custom'; render: ReactNode };

const PERSONA = 'Ada';

/** `v2 · gpt-5.4-mini · first token 2354ms · total 2787ms · 2 steps · lookup_order, get_store_hours` */
const describeTurn = (done: DoneFrame): string => {
  const version = done.prompt.version === 'fallback' ? 'fallback' : `v${done.prompt.version}`;
  const parts = [
    version,
    done.model,
    `first token ${done.ttftMs ?? '—'}ms`,
    `total ${done.totalMs ?? '—'}ms`,
    `${done.steps} step${done.steps === 1 ? '' : 's'}`,
  ];
  if (done.toolCalls.length > 0) parts.push(done.toolCalls.join(', '));
  if (done.aborted) parts.push('aborted');
  return parts.join(' · ');
};

export function BenchChat() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const [lastTurn, setLastTurn] = useState<DoneFrame | null>(null);
  /**
   * Held in a ref rather than state: it is read inside `send` and must be the value from the LAST
   * completed turn, not the one captured when this render's closure was created. A state variable
   * here silently starts a fresh conversation on the second message of a fast exchange.
   */
  const conversationId = useRef<string | null>(null);
  const nextId = useRef(0);
  const id = (): string => `e${nextId.current++}`;

  const send = useCallback(async (text: string): Promise<void> => {
    setBusy(true);
    const assistantId = id();
    setEntries((prev) => [
      ...prev,
      { id: id(), type: 'message', author: 'You', text, side: 'end' },
      // Appended empty and filled in as deltas arrive, so the reader sees the answer being written
      // rather than waiting for it. This is the browser-side half of what TTFT measures.
      { id: assistantId, type: 'message', author: PERSONA, text: '', side: 'start', authorColor: 'accent' },
    ]);

    const fail = (message: string): void => {
      setEntries((prev) => [...prev, { id: id(), type: 'event', variant: 'error', text: message }]);
    };

    try {
      const response = await fetch(BENCH_TURN_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text,
          ...(conversationId.current !== null && { conversationId: conversationId.current }),
        }),
      });

      if (!response.ok) {
        // The documented degradation path: 503 names the missing variable, so show that rather
        // than "something went wrong".
        const detail = (await response.json().catch(() => null)) as { missing?: { name: string }[] } | null;
        const missing = detail?.missing?.map((m) => m.name).join(', ');
        fail(
          response.status === 503 && missing !== undefined && missing !== ''
            ? `The agent is not configured: ${missing} is not set.`
            : `The agent returned ${response.status}.`,
        );
        return;
      }
      if (response.body === null) {
        fail('The response carried no body, so nothing could be streamed.');
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // Frames are terminated by a blank line, and a chunk boundary can land anywhere — including
      // mid-terminator. So the buffer is only consumed up to the last COMPLETE frame it holds.
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let split = buffer.indexOf('\n\n');
        while (split !== -1) {
          const block = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          split = buffer.indexOf('\n\n');

          const event = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          // Skips SSE comment frames (`: keep-alive`) without special-casing them.
          if (event === undefined || data === undefined) continue;
          const payload = JSON.parse(data) as Record<string, unknown>;

          if (event === 'start') {
            conversationId.current = String(payload.conversationId);
          } else if (event === 'token') {
            const delta = String(payload.delta);
            setEntries((prev) =>
              prev.map((e) =>
                e.id === assistantId && e.type === 'message' ? { ...e, text: e.text + delta } : e,
              ),
            );
          } else if (event === 'done') {
            const frame = payload as unknown as DoneFrame;
            setLastTurn(frame);
            setEntries((prev) => [
              ...prev,
              frame.aborted
                ? { id: id(), type: 'event', variant: 'warning', text: describeTurn(frame) }
                : {
                    // ChatLog's `custom` escape hatch rather than an `event` banner. An `info` banner
                    // is a full-width filled bar — right for something the reader must not miss, and
                    // far too loud for a timing footnote that appears after EVERY turn. An abort is a
                    // banner, because that one is news.
                    id: id(),
                    type: 'custom',
                    render: (
                      <p className="text-text-secondary font-mono text-xs" data-testid="turn-metrics">
                        {describeTurn(frame)}
                      </p>
                    ),
                  },
            ]);
          } else if (event === 'error') {
            fail(String(payload.error));
          }
        }
      }
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge label="bench" variant="feature" />
        <Badge label="no Twilio credentials required" variant="neutral" />
        {lastTurn !== null && (
          <Badge
            label={lastTurn.prompt.version === 'fallback' ? 'prompt: fallback' : `prompt v${lastTurn.prompt.version}`}
            variant={lastTurn.prompt.version === 'fallback' ? 'neutral' : 'feature'}
          />
        )}
      </div>

      {/*
        Two classes here are load-bearing, both learned from the rendered page rather than the docs:

        `min-h-0` — without it a scrolling flex child grows the page instead of scrolling, and
        stick-to-bottom has nothing to stick to.

        `px-4` — ChatLog's own root carries NO horizontal padding (`flex flex-col gap-gap-400 min-h-0
        w-full overflow-y-auto`), and a `side: 'end'` message is a `flex-row-reverse` row whose author
        label is `shrink-0 min-w-14`. Flush against a bordered container, the author of every one of
        the reader's own messages is clipped — "You" rendered as "Yo". The component takes no
        `className`, so the padding has to live out here. Invisible in a DOM snapshot, obvious in a
        screenshot.
      */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-card-card-primary px-4 py-3">
        <ChatLog
          entries={entries}
          emptyTitle="Say something to the agent"
          emptyBody="This runs the same runTurn() that voice and SMS will. No phone, no Twilio credentials."
        />
      </div>

      <ChatInput
        onSend={(message) => void send(message)}
        disabled={busy}
        shape="panel"
        label="Message the agent"
        placeholder={busy ? 'Waiting for the agent…' : 'Ask about order A4721, or the Downtown store hours'}
      />

      <Typography variant="body-xs" as="p" className="text-text-secondary">
        Every turn also publishes to the live event stream and to Langfuse. Timings above are measured
        from the start of the turn, so they include the prompt fetch and tool resolution that sit in
        front of the first word.
      </Typography>
    </div>
  );
}
