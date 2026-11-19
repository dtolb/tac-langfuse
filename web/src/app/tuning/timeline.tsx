'use client';

import { useState } from 'react';
import { Badge } from '@gtmi/strix-react/atoms/badge';
import { MetricList } from '@gtmi/strix-react/atoms/metric-list';
import { NativeSelect, NativeSelectOption } from '@gtmi/strix-react/atoms/native-select';
import { Separator } from '@gtmi/strix-react/atoms/separator';
import { Tabs } from '@gtmi/strix-react/atoms/tabs';
import { Typography } from '@gtmi/strix-react/atoms/typography';
import { cn } from '@gtmi/strix-react/cn';
import { TIMING_LABEL } from '../../../../shared/cr-params.ts';
import type { Apply, CallTimeline, Turn } from '../../../../shared/tuning-api.ts';

const LANES = [
  { id: 'caller', label: 'Caller', bar: 'bg-accent-sky-100', source: 'insights' },
  { id: 'stt', label: 'STT', bar: 'bg-accent-lavender-200', source: 'insights' },
  { id: 'app', label: 'App', bar: 'bg-surface-accent-strong', source: 'live' },
  { id: 'tts', label: 'TTS', bar: 'bg-accent-sun-200', source: 'insights' },
  { id: 'audio', label: 'Agent audio', bar: 'bg-accent-mint-500', source: 'insights' },
] as const;

type LaneId = (typeof LANES)[number]['id'];

const lane = (id: LaneId) => LANES.find((l) => l.id === id)!;

/** Start and end of one lane's segment for a turn, in ms from call start. */
function segment(turn: Turn, id: LaneId): readonly [number, number] {
  switch (id) {
    case 'caller':
      return [turn.callerStart, turn.utteranceEnd];
    case 'stt':
      return [turn.utteranceEnd, turn.sttEnd];
    case 'app':
      return [turn.sttEnd, turn.firstToken];
    case 'tts':
      return [turn.firstToken, turn.audioStart];
    case 'audio':
      return [turn.audioStart, turn.audioEnd];
  }
}

const pct = (ms: number, total: number): string => `${(ms / total) * 100}%`;

/** Wait from the caller's utterance end to the first agent audio. */
const waitMs = (t: Turn): number => t.audioStart - t.utteranceEnd;

const median = (xs: readonly number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

interface Stats {
  readonly wait: number | null;
  readonly stt: number | null;
  readonly app: number | null;
  readonly tts: number | null;
}

/** Median stage times over turns; Twilio-side stages only count turns Voice Insights has filled. */
function stats(turns: readonly Turn[]): Stats {
  const done = turns.filter((t) => t.insights);
  return {
    wait: median(done.map(waitMs)),
    stt: median(done.map((t) => t.sttEnd - t.utteranceEnd)),
    app: median(turns.map((t) => t.firstToken - t.sttEnd)),
    tts: median(done.map((t) => t.audioStart - t.firstToken)),
  };
}

const signed = (a: number | null, b: number | null): string | null => (a === null || b === null ? null : `${b - a > 0 ? '+' : ''}${b - a}`);

/** The colour key, shown above every view. */
export function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-gap-300">
      {LANES.map((l) => (
        <Key key={l.id} className={l.bar} label={l.label} />
      ))}
      <Key className="border border-dashed border-border-neutral-medium" label="Awaiting Voice Insights" />
      <Key className="w-0.5 bg-surface-accent-strong" label="Apply sent" />
      <Key className="w-0 border-l-2 border-dashed border-border-success" label="Took effect" />
    </div>
  );
}

function Key({ className, label }: { readonly className: string; readonly label: string }) {
  return (
    <span className="flex items-center gap-gap-100">
      <span className={cn('inline-block h-3 w-3 rounded-xs', className)} />
      <Typography variant="body-xs" className="text-text-secondary">
        {label}
      </Typography>
    </span>
  );
}

/** One stacked STT + app + TTS bar for a turn, on a shared scale. */
function WaitBar({ turn, scale }: { readonly turn: Turn; readonly scale: number }) {
  return (
    <div className="flex h-5 flex-1">
      {(['stt', 'app', 'tts'] as const).map((id) => {
        const [a, b] = segment(turn, id);
        const spec = lane(id);
        const pending = spec.source === 'insights' && !turn.insights;
        return (
          <div
            key={id}
            className={cn('h-5 min-w-1', pending ? 'border border-dashed border-border-neutral-medium' : spec.bar)}
            style={{ width: pct(b - a, scale) }}
            title={`${spec.label} ${b - a} ms`}
          />
        );
      })}
    </div>
  );
}

/** The divider row for one Apply: what changed, when each part took effect, and how wait moved. */
function ApplyRow({ apply, call }: { readonly apply: Apply; readonly call: CallTimeline }) {
  const before = stats(call.turns.filter((t) => t.rev === String(apply.rev - 1)));
  const after = call.turns.filter((t) => t.rev === String(apply.rev));
  const afterStats = stats(after);
  return (
    <div className="flex flex-col gap-gap-100 rounded-sm border-l-2 border-border-accent bg-surface-accent-ultra-soft px-3 py-2">
      <div className="flex flex-wrap items-center gap-gap-200">
        <Badge label={`rev ${apply.rev}`} variant="brand10" size="small" />
        <Typography variant="body-xs-semibold">Applied {apply.wall}</Typography>
        {apply.preset && (
          <Typography variant="body-xs" className="text-text-secondary">
            from {apply.preset}
          </Typography>
        )}
      </div>
      {apply.changes.map((c) => (
        <div key={c.key} className="flex flex-wrap items-center gap-gap-200">
          <Typography variant="mono-s-regular">
            {c.key} {c.from} → {c.to}
          </Typography>
          <Typography variant="body-xs" className="text-text-tertiary">
            {TIMING_LABEL[c.timing]}
          </Typography>
          {c.effectiveAt === null ? (
            <Badge label="awaiting configUpdated" variant="warning" size="small" />
          ) : (
            <Badge label={`took effect +${c.effectiveAt - apply.at} ms${c.firstTurn ? ` · turn ${c.firstTurn}` : ''}`} variant="success" size="small" />
          )}
        </div>
      ))}
      {apply.nextCall.length > 0 && (
        <Typography variant="body-xs" className="text-text-tertiary">
          Next call only: {apply.nextCall.join(', ')}
        </Typography>
      )}
      <Typography variant="body-xs" as="p" className="text-text-secondary">
        {after.length === 0
          ? 'No turns on this revision yet.'
          : afterStats.wait === null
            ? `App median ${before.app ?? '--'} → ${afterStats.app} ms (${signed(before.app, afterStats.app)}). Wait, STT and TTS once Voice Insights arrives.`
            : `Median wait ${before.wait} → ${afterStats.wait} ms (${signed(before.wait, afterStats.wait)}) · STT ${signed(before.stt, afterStats.stt)} · App ${signed(before.app, afterStats.app)} · TTS ${signed(before.tts, afterStats.tts)}`}
      </Typography>
    </div>
  );
}

/** Per-turn wait, zeroed at utterance end, with each Apply as a divider before the turn it was sent during. */
function PerTurnWait({ call }: { readonly call: CallTimeline }) {
  const scale = Math.max(...call.turns.map(waitMs), 2_000);
  const rowsBefore = (t: Turn) => call.applies.filter((a) => a.at <= t.sttEnd && (t.n === 1 || a.at > call.turns[t.n - 2]!.sttEnd));
  const last = call.turns.at(-1);
  const trailing = last ? call.applies.filter((a) => a.at > last.sttEnd) : call.applies;

  return (
    <div className="flex w-full flex-col gap-gap-100">
      {call.turns.map((turn) => (
        <div key={turn.n} className="flex flex-col gap-gap-100">
          {rowsBefore(turn).map((a) => (
            <ApplyRow key={a.applyId} apply={a} call={call} />
          ))}
          <div className="flex items-center gap-gap-300">
            <Typography variant="body-xs-semibold" as="div" className="w-14 shrink-0 text-text-secondary">
              Turn {turn.n}
            </Typography>
            <WaitBar turn={turn} scale={scale} />
            <Typography variant="mono-s-regular" as="div" className="w-52 shrink-0 text-right" title="STT · App · TTS = wait">
              {turn.insights
                ? `${turn.sttEnd - turn.utteranceEnd} · ${turn.firstToken - turn.sttEnd} · ${turn.audioStart - turn.firstToken} = ${waitMs(turn)} ms`
                : `… · ${turn.firstToken - turn.sttEnd} · … ms`}
            </Typography>
            <Badge label={`rev ${turn.rev}`} variant={turn.rev.includes('→') ? 'warning' : 'neutral'} size="small" />
          </div>
        </div>
      ))}
      {trailing.map((a) => (
        <ApplyRow key={a.applyId} apply={a} call={call} />
      ))}
      {call.turns.length === 0 && (
        <Typography variant="body-s" as="p" className="text-text-tertiary">
          No turns yet.
        </Typography>
      )}
    </div>
  );
}

/** Five lanes on one time axis, with each Apply and its took-effect points labelled in place. */
function WholeCall({ call }: { readonly call: CallTimeline }) {
  const total = Math.max(call.durationMs, 1);
  const ticks = Array.from({ length: Math.floor(total / 10_000) + 1 }, (_, i) => i * 10_000);
  return (
    <div className="flex w-full flex-col gap-gap-200">
      <div className="flex w-full gap-gap-300">
        <div className="flex w-24 shrink-0 flex-col">
          {[...LANES.map((l) => l.label), 'Applies'].map((label) => (
            <div key={label} className="flex h-8 items-center">
              <Typography variant="body-xs-semibold" className="text-text-secondary">
                {label}
              </Typography>
            </div>
          ))}
        </div>
        <div className="relative flex-1">
          {LANES.map((l) => (
            <div key={l.id} className="relative h-8 border-b border-border-neutral-extra-soft">
              {l.id === 'audio' && (
                <div className="absolute top-2 h-4 rounded-xs bg-accent-mint-500 opacity-60" style={{ left: pct(400, total), width: pct(call.greetingEnd - 400, total) }} title="Welcome greeting" />
              )}
              {call.turns.map((turn) => {
                const [a, b] = segment(turn, l.id);
                const pending = l.source === 'insights' && !turn.insights;
                return (
                  <div
                    key={turn.n}
                    className={cn('absolute top-2 h-4 min-w-1 rounded-xs', pending ? 'border border-dashed border-border-neutral-medium' : l.bar)}
                    style={{ left: pct(a, total), width: pct(b - a, total) }}
                    title={`Turn ${turn.n} · ${l.label} · ${b - a} ms`}
                  />
                );
              })}
              {l.id === 'audio' &&
                call.turns
                  .filter((t) => t.interrupted)
                  .map((t) => (
                    <span key={t.n} className="absolute -top-1 -translate-x-1/2" style={{ left: pct(t.audioEnd, total) }}>
                      <Badge label="cut short" variant="warning" size="small" />
                    </span>
                  ))}
            </div>
          ))}
          <div className="relative h-8" />
          {call.applies.map((a) => {
            const effective = [...new Set(a.changes.map((c) => c.effectiveAt).filter((e): e is number => e !== null))];
            const keysAt = (e: number) => a.changes.filter((c) => c.effectiveAt === e).map((c) => c.key).join(', ');
            return (
              <div key={a.applyId}>
                <div className="absolute top-0 bottom-8 w-0.5 bg-surface-accent-strong" style={{ left: pct(a.at, total) }} />
                {effective.map((e) => (
                  <div key={e} className="absolute top-0 bottom-8 border-l-2 border-dashed border-border-success" style={{ left: pct(e, total) }} />
                ))}
                <span className="absolute bottom-1 flex -translate-x-1/2 items-center gap-gap-100" style={{ left: pct(a.at, total) }}>
                  <Badge label={`rev ${a.rev}`} variant="brand10" size="small" />
                  <Typography variant="body-xs" className="whitespace-nowrap text-text-secondary">
                    {effective.length ? effective.map((e) => `${keysAt(e)} +${e - a.at} ms`).join(' · ') : 'awaiting configUpdated'}
                  </Typography>
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <div className="ml-27 flex justify-between">
        {ticks.map((t) => (
          <Typography key={t} variant="body-xs" className="text-text-tertiary">
            {t / 1000}s
          </Typography>
        ))}
      </div>
    </div>
  );
}

/** Per-turn numbers. */
function TurnTable({ call }: { readonly call: CallTimeline }) {
  const head = ['Turn', 'Rev', 'Talk', 'STT', 'App', 'TTS', 'Wait', 'Audio', ''];
  const ms = (v: number, ok: boolean) => (ok ? `${v} ms` : '…');
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-border-neutral-soft">
            {head.map((h) => (
              <th key={h} className="px-2 py-1 text-left">
                <Typography variant="body-xs-semibold" className="text-text-secondary">
                  {h}
                </Typography>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {call.turns.map((t) => (
            <tr key={t.n} className="border-b border-border-neutral-extra-soft">
              {[
                String(t.n),
                t.rev,
                ms(t.utteranceEnd - t.callerStart, t.insights),
                ms(t.sttEnd - t.utteranceEnd, t.insights),
                ms(t.firstToken - t.sttEnd, true),
                ms(t.audioStart - t.firstToken, t.insights),
                ms(waitMs(t), t.insights),
                ms(t.audioEnd - t.audioStart, t.insights),
              ].map((c, i) => (
                <td key={i} className="px-2 py-1">
                  <Typography variant="mono-s-regular">{c}</Typography>
                </td>
              ))}
              <td className="px-2 py-1">{t.interrupted && <Badge label="reply cut short" variant="warning" size="small" />}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface Segment {
  readonly id: string;
  readonly label: string;
  readonly turns: readonly Turn[];
}

/** One segment per call per revision, skipping turns split across two revisions. */
function segments(calls: readonly CallTimeline[]): Segment[] {
  return calls.flatMap((c) =>
    [...new Set(c.turns.map((t) => t.rev).filter((r) => !r.includes('→')))].map((rev) => {
      const turns = c.turns.filter((t) => t.rev === rev);
      return { id: `${c.sid}:${rev}`, label: `${c.sid.slice(0, 6)} · rev ${rev} · ${turns.length} turns`, turns };
    }),
  );
}

/** This call's latest revision against any other call-and-revision segment. */
function CompareWith({ call, calls }: { readonly call: CallTimeline; readonly calls: readonly CallTimeline[] }) {
  const all = segments(calls);
  const own = all.filter((s) => s.id.startsWith(call.sid));
  const split = call.turns.filter((t) => t.rev.includes('→')).length;
  const [left, setLeft] = useState((own.length > 1 ? own.at(-2) : all.find((s) => !s.id.startsWith(call.sid)))?.id ?? '');
  const [right, setRight] = useState((own.at(-1) ?? all[0])?.id ?? '');
  const a = stats(all.find((s) => s.id === left)?.turns ?? []);
  const b = stats(all.find((s) => s.id === right)?.turns ?? []);
  const rows = (s: Stats) => (['wait', 'stt', 'app', 'tts'] as const).map((k) => ({ label: k === 'wait' ? 'Wait' : k.toUpperCase(), value: s[k], unit: 'ms' }));

  const picker = (value: string, set: (v: string) => void, label: string) => (
    <NativeSelect aria-label={label} value={value} onChange={(e) => set(e.target.value)} containerClassName="md:w-72">
      {all.map((s) => (
        <NativeSelectOption key={s.id} value={s.id}>
          {s.label}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );

  if (all.length === 0) {
    return (
      <Typography variant="body-s" as="p" className="text-text-tertiary">
        Nothing to compare until a call has turns.
      </Typography>
    );
  }

  return (
    <div className="flex flex-col gap-gap-300">
      <div className="flex flex-col gap-gap-200 md:flex-row md:items-center">
        <Typography variant="body-s-semibold">Compare</Typography>
        {picker(left, setLeft, 'Compare segment')}
        <Typography variant="body-s" className="text-text-secondary">
          with
        </Typography>
        {picker(right, setRight, 'Compare with segment')}
        {split > 0 && (
          <Typography variant="body-xs" className="text-text-tertiary">
            {split} turn{split > 1 ? 's' : ''} split across revisions left out
          </Typography>
        )}
      </div>
      <MetricList
        groups={[
          { heading: all.find((s) => s.id === left)?.label, metrics: rows(a) },
          { heading: all.find((s) => s.id === right)?.label, metrics: rows(b) },
          { heading: 'Change', metrics: (['wait', 'stt', 'app', 'tts'] as const).map((k) => ({ label: k === 'wait' ? 'Wait' : k.toUpperCase(), value: signed(a[k], b[k]), unit: 'ms' })) },
        ]}
      />
    </div>
  );
}

/** Everything about one call: its timeline in three views, then comparison against other segments. */
export function CallView({ call, calls }: { readonly call: CallTimeline; readonly calls: readonly CallTimeline[] }) {
  return (
    <div className="flex w-full flex-col gap-gap-300 pt-3">
      <Typography variant="body-xs" as="p" className="text-text-tertiary">
        {call.from} · {call.turns.length} turns · started on rev {call.startRev}. {call.insightsNote}
      </Typography>
      <Legend />
      <Tabs
        variant="small"
        aria-label="Timeline view"
        defaultValue="wait"
        rootClassName="w-full"
        panelClassName="w-full"
        items={[
          { value: 'wait', label: 'Per-turn wait', content: <PerTurnWait call={call} /> },
          { value: 'whole', label: 'Whole call', content: <WholeCall call={call} /> },
          { value: 'table', label: 'Table', content: <TurnTable call={call} /> },
        ]}
      />
      <Separator />
      <CompareWith key={`${call.sid}:${segments([call]).map((x) => x.id).join(',')}`} call={call} calls={calls} />
    </div>
  );
}
