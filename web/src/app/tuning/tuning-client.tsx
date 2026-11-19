'use client';

import { useEffect, useRef, useState } from 'react';
import { Badge } from '@gtmi/strix-react/atoms/badge';
import { Button } from '@gtmi/strix-react/atoms/button';
import { CallTimer } from '@gtmi/strix-react/atoms/call-timer';
import { Card, CardContent, CardHeader, CardTitle } from '@gtmi/strix-react/atoms/card';
import { Checkbox } from '@gtmi/strix-react/atoms/checkbox';
import { IconButton } from '@gtmi/strix-react/atoms/icon-button';
import { Input } from '@gtmi/strix-react/atoms/input';
import { NativeSelect, NativeSelectOption } from '@gtmi/strix-react/atoms/native-select';
import { Tabs } from '@gtmi/strix-react/atoms/tabs';
import { ToggleGroup, ToggleGroupItem } from '@gtmi/strix-react/atoms/toggle-group';
import { Tooltip } from '@gtmi/strix-react/atoms/tooltip';
import { Typography } from '@gtmi/strix-react/atoms/typography';
import { cn } from '@gtmi/strix-react/cn';
import { ExternalLinkIcon } from '@gtmi/strix-react/icons/external-link';
import { InfoIcon } from '@gtmi/strix-react/icons/info';
import {
  DYNAMIC_CONFIG_URL,
  GROUPS,
  PARAMS,
  PRESETS,
  TIMING_HELP,
  TIMING_LABEL,
  TIMING_ORDER,
  TWILIO_DEFAULTS,
  configFrame,
  diffKeys,
  optionsFor,
  param,
  relayAttributes,
  type ConfigFrame,
  type Group,
  type Param,
  type Preset,
  type Profile,
  type Timing,
} from '../../../../shared/cr-params.ts';
import type { ObsEvent, ObsEventKind } from '../../../../shared/events.ts';
import {
  CALLS_PATH,
  TUNING_APPLY_PATH,
  TUNING_PATH,
  callTimelinePath,
  tuningPresetPath,
  type ApiError,
  type ApplyRequest,
  type ApplyResponse,
  type CallSummary,
  type CallTimeline,
  type CallsResponse,
  type CrConfigErrorPayload,
  type LiveCall,
  type SavePresetRequest,
  type SavePresetResponse,
  type TuningState,
} from '../../../../shared/tuning-api.ts';
import { SSE_PATH } from '../../../../shared/twilio-paths.ts';
import { CallView } from './timeline.tsx';

const TIMING_VARIANT: Readonly<Record<Timing, 'success' | 'feature' | 'new' | 'neutral'>> = {
  now: 'success',
  'turn-end': 'feature',
  'next-reply': 'new',
  'next-call': 'neutral',
};

const REFRESH_KINDS: ReadonlySet<ObsEventKind> = new Set<ObsEventKind>([
  'cr.config.apply',
  'cr.config.updated',
  'cr.config.error',
  'turn.end',
  'voice.setup',
  'voice.end',
  'voice.disconnect',
]);

const POLL_MS = 15_000;
const REFRESH_DEBOUNCE_MS = 400;

/**
 * Fetches `path` and parses the JSON body.
 *
 * @param init - When given, sends `body` as JSON with `method`.
 * @returns The parsed body.
 * @throws Error carrying the server's `error`, or the status, on a non-2xx or non-JSON response.
 */
async function api<T>(path: string, init?: { readonly method: string; readonly body: unknown }): Promise<T> {
  const res = await fetch(
    path,
    init && { method: init.method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) },
  );
  const body = (await res.json().catch(() => null)) as T | ApiError | null;
  if (!res.ok || body === null) throw new Error((body as ApiError | null)?.error ?? `${path} answered ${res.status}`);
  return body as T;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Formats a NANP E.164 number as `+1 555-123-4567`; any other number is returned unchanged. */
const formatPhone = (e164: string): string => {
  const m = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `+1 ${m[1]}-${m[2]}-${m[3]}` : e164;
};

/** Returns how long ago `endedAt` (ISO 8601) was, as a tab label. */
const endedAgo = (endedAt: string | null): string => {
  if (!endedAt) return 'ended';
  const min = Math.round((Date.now() - Date.parse(endedAt)) / 60_000);
  return min < 1 ? 'ended just now' : `ended ${min} min ago`;
};

/** Returns the live call that last received an Apply, else the first call listed, else `null`. */
function defaultSelection(calls: readonly CallSummary[], live: readonly LiveCall[]): string | null {
  const byRev = [...live].sort((a, b) => b.rev - a.rev).find((l) => calls.some((c) => c.sid === l.sid));
  return byRev?.sid ?? calls[0]?.sid ?? null;
}

/** Renders the `<ConversationRelay>` element the next call's TwiML will carry. */
function twimlPreview(v: Profile): string {
  const attrs = relayAttributes(v);
  const pinned = 'reportInputDuringAgentSpeech' in attrs ? [] : ['  reportInputDuringAgentSpeech="any"'];
  const lines = Object.entries(attrs).map(([k, val]) => `  ${k}="${String(val)}"`);
  return ['<ConversationRelay url="wss://…/ws"', ...pinned, ...lines].join('\n') + ' />';
}

/** A timing class label with its one-line meaning beside it. */
function TimingBadge({ timing }: { readonly timing: Timing }) {
  return (
    <span className="flex items-center gap-gap-200">
      <Badge label={TIMING_LABEL[timing]} variant={TIMING_VARIANT[timing]} size="small" />
      <Typography variant="body-xs" className="text-text-tertiary">
        {TIMING_HELP[timing]}
      </Typography>
    </span>
  );
}

/** A plain-text tooltip on an info icon saying what the parameter does, and a visible link to its reference page. */
function ParamHelp({ p }: { readonly p: Param }) {
  return (
    <span className="flex items-center">
      <Tooltip side="right" title={p.label} text={p.doc}>
        <IconButton variant="ghost" size="xs" aria-label={`About ${p.label}: ${p.doc}`} iconLeft={<InfoIcon size="sm" />} />
      </Tooltip>
      <IconButton
        variant="ghost"
        size="xs"
        aria-label={`${p.label} in the Twilio docs`}
        render={<a href={p.url} target="_blank" rel="noreferrer" />}
        iconLeft={<ExternalLinkIcon size="sm" />}
      />
    </span>
  );
}

/** The control for one parameter, chosen by its `kind`. */
function Control(props: { readonly p: Param; readonly value: string; readonly profile: Profile; readonly disabled: boolean; readonly onChange: (v: string) => void }) {
  const { p, value, profile, disabled, onChange } = props;
  const options = optionsFor(p, profile);
  if (p.kind === 'bool') {
    return <Checkbox checked={value === 'true'} disabled={disabled} onCheckedChange={(c) => onChange(c ? 'true' : 'false')} aria-label={p.label} />;
  }
  if (p.kind === 'segmented') {
    return (
      <ToggleGroup aria-label={p.label} value={[value]} disabled={disabled} onValueChange={(next) => next[0] && onChange(next[0])}>
        {options.map((o) => (
          <ToggleGroupItem key={o} value={o}>
            {o}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    );
  }
  if (p.kind === 'select') {
    return (
      <NativeSelect aria-label={p.label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} containerClassName="w-80">
        {options.map((o) => (
          <NativeSelectOption key={o} value={o}>
            {o}
            {o === TWILIO_DEFAULTS[p.key] ? ' (default)' : ''}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    );
  }
  return <Input aria-label={p.label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} containerClassName="w-80" />;
}

/** One parameter: label, help and attribute name on the left, control on the right; a changed row shows what it was. */
function ParamRow(props: { readonly p: Param; readonly applied: Profile; readonly staged: Profile; readonly onChange: (key: string, v: string) => void }) {
  const { p, applied, staged, onChange } = props;
  const changed = applied[p.key] !== staged[p.key];
  const reason = p.disabledReason?.(staged) ?? null;
  return (
    <div className={cn('flex items-center justify-between gap-gap-300 rounded-sm px-2 py-1.5', changed && 'bg-surface-accent-ultra-soft')}>
      <div className="flex min-w-0 flex-col">
        <div className="flex items-center gap-gap-100">
          <Typography variant="body-s-medium" className={cn(reason && 'text-text-disabled')}>
            {p.label}
          </Typography>
          <ParamHelp p={p} />
        </div>
        <div className="flex flex-wrap items-center gap-gap-200">
          <Typography variant="mono-s-regular" className="text-text-tertiary">
            {p.key === 'elevenlabsModel' ? 'voice suffix' : p.key}
          </Typography>
          {changed && (
            <Typography variant="body-xs" className="text-text-accent">
              was {applied[p.key] || '(empty)'}
            </Typography>
          )}
          {!changed && reason && (
            <Typography variant="body-xs" className="text-text-tertiary">
              {reason}
            </Typography>
          )}
        </div>
      </div>
      <Control p={p} value={staged[p.key] ?? ''} profile={staged} disabled={p.locked === true || reason !== null} onChange={(v) => onChange(p.key, v)} />
    </div>
  );
}

/** Rows under one timing subhead per timing class, in `TIMING_ORDER`. */
function TimingBlocks(props: { readonly params: readonly Param[]; readonly applied: Profile; readonly staged: Profile; readonly onChange: (key: string, v: string) => void }) {
  return (
    <>
      {TIMING_ORDER.filter((t) => props.params.some((p) => p.timing === t)).map((t) => (
        <div key={t} className="flex flex-col">
          <div className="px-2 pt-2 pb-1">
            <TimingBadge timing={t} />
          </div>
          {props.params
            .filter((p) => p.timing === t)
            .map((p) => (
              <ParamRow key={p.key} p={p} applied={props.applied} staged={props.staged} onChange={props.onChange} />
            ))}
        </div>
      ))}
    </>
  );
}

/** A folded section with a count of its rows and how many are changed. */
function Disclosure(props: { readonly label: string; readonly count: number; readonly changed: number; readonly children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex items-center gap-gap-200 px-2 py-2 text-left">
        <Typography variant="body-s-semibold" className="text-text-accent">
          {open ? '▾' : '▸'} {props.label} ({props.count})
        </Typography>
        {props.changed > 0 && <Badge label={`${props.changed} changed`} variant="brand10" size="small" />}
      </button>
      {open && props.children}
    </div>
  );
}

/** One settings group: common rows first, the rest behind "More". "Next call only" is folded entirely. */
function GroupCard(props: { readonly group: Group; readonly title: string; readonly applied: Profile; readonly staged: Profile; readonly onChange: (key: string, v: string) => void }) {
  const params = PARAMS.filter((p) => p.group === props.group);
  const changedIn = (ps: readonly Param[]) => ps.filter((p) => props.applied[p.key] !== props.staged[p.key]).length;
  const rest = { applied: props.applied, staged: props.staged, onChange: props.onChange };

  if (props.group === 'next-call') {
    return (
      <Card variant="default" padding="sm">
        <Disclosure label={props.title} count={params.length} changed={changedIn(params)}>
          <TimingBlocks params={params} {...rest} />
        </Disclosure>
      </Card>
    );
  }
  const common = params.filter((p) => p.common);
  const more = params.filter((p) => !p.common);
  return (
    <Card variant="default" padding="sm">
      <CardHeader>
        <CardTitle as="h2">{props.title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col">
        <TimingBlocks params={common} {...rest} />
        {more.length > 0 && (
          <Disclosure label="More" count={more.length} changed={changedIn(more)}>
            <TimingBlocks params={more} {...rest} />
          </Disclosure>
        )}
      </CardContent>
    </Card>
  );
}

/** What the last Apply did on each live call: took-effect time from `configUpdated`, or Twilio's rejection. */
interface Receipt {
  readonly rev: number;
  readonly calls: readonly { readonly sid: string; readonly effectiveMs: number | null; readonly error: string | null }[];
  readonly nextCall: boolean;
}

/** A `cr.config.error` event as received, with its server timestamp in epoch ms. */
interface ReceivedError {
  readonly payload: CrConfigErrorPayload;
  readonly at: number;
}

/**
 * Builds the receipt for an Apply.
 *
 * @param last - The Apply response and the epoch ms it was sent at.
 * @param timelines - Loaded timelines; each reached call's matching Apply supplies the took-effect time.
 * @param errors - `cr.config.error` events; one matches when its `applyId` is this Apply's, or is `null` and arrived after it.
 */
function receiptFor(last: { readonly response: ApplyResponse; readonly at: number }, timelines: Readonly<Record<string, CallTimeline>>, errors: readonly ReceivedError[]): Receipt {
  const r = last.response;
  return {
    rev: r.rev,
    nextCall: r.changes.length > 0,
    calls: r.calls
      .filter((c) => c.frame !== null)
      .map((c) => {
        const rejected = errors.find((e) => e.payload.callSid === c.sid && (e.payload.applyId === r.applyId || (e.payload.applyId === null && e.at >= last.at)));
        const a = timelines[c.sid]?.applies.find((x) => x.applyId === r.applyId);
        const effective = a?.changes.map((ch) => (ch.effectiveAt === null ? null : ch.effectiveAt - a.at)) ?? [];
        const done = effective.length > 0 && effective.every((e) => e !== null);
        return { sid: c.sid, error: c.error ?? rejected?.payload.description ?? null, effectiveMs: done ? Math.max(...(effective as number[])) : null };
      }),
  };
}

/** The sticky bar: staged changes (or the last Apply's receipt) on one line, and the Apply that names where they go. The wire panel below it scrolls away. */
function ApplyBar(props: {
  readonly applied: Profile;
  readonly staged: Profile;
  readonly stagedPreset: string | null;
  readonly receipt: Receipt | null;
  readonly lastFrame: ConfigFrame | null;
  readonly liveCalls: number;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onApply: () => void;
  readonly onDiscard: () => void;
}) {
  const [wire, setWire] = useState(false);
  const keys = diffKeys(props.applied, props.staged);
  const live = keys.filter((k) => param(k).timing !== 'next-call');
  const next = keys.filter((k) => param(k).timing === 'next-call');
  const target = [live.length ? `${props.liveCalls} live calls` : null, next.length || live.length ? 'next call' : null].filter(Boolean).join(' + ');
  const frame = keys.length ? configFrame(keys, props.staged) : props.lastFrame;

  return (
    <>
      <div className="sticky top-0 z-10 -mx-8 border-b border-border-neutral-soft bg-surface-base px-8 py-3">
        <div className="flex flex-col gap-gap-200 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex flex-wrap items-center gap-gap-200">
            {keys.length > 0 ? (
              <>
                <Typography variant="body-s-semibold">
                  {keys.length} staged{props.stagedPreset ? ` from ${props.stagedPreset}` : ''}
                </Typography>
                {keys.map((k) => (
                  <span key={k} className="flex items-center gap-gap-100 rounded-sm bg-surface-field px-2 py-1">
                    <Typography variant="mono-s-regular">
                      {k} {props.applied[k] ? props.applied[k].slice(0, 24) : '(empty)'} → {props.staged[k] ? props.staged[k].slice(0, 24) : '(empty)'}
                    </Typography>
                    <Typography variant="body-xs" className="text-text-tertiary">
                      {TIMING_LABEL[param(k).timing]}
                    </Typography>
                  </span>
                ))}
              </>
            ) : props.receipt ? (
              <>
                <Badge label={`rev ${props.receipt.rev}`} variant="brand10" size="small" />
                {props.receipt.calls.map((c) =>
                  c.error !== null ? (
                    <span key={c.sid} className="flex items-center gap-gap-100">
                      <Badge label={`${c.sid.slice(0, 6)} rejected`} variant="error" size="small" />
                      <Typography variant="body-xs" className="text-text-error">
                        {c.error}
                      </Typography>
                    </span>
                  ) : (
                    <Badge
                      key={c.sid}
                      label={c.effectiveMs === null ? `${c.sid.slice(0, 6)} awaiting configUpdated` : `${c.sid.slice(0, 6)} took effect +${c.effectiveMs} ms`}
                      variant={c.effectiveMs === null ? 'warning' : 'success'}
                      size="small"
                    />
                  ),
                )}
                {props.receipt.nextCall && <Badge label="saved for next call" variant="neutral" size="small" />}
              </>
            ) : (
              <Typography variant="body-s" className="text-text-tertiary">
                Nothing staged. Change a setting or stage a preset.
              </Typography>
            )}
            {props.error && (
              <Typography variant="body-xs" className="text-text-error">
                Apply failed: {props.error}
              </Typography>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-gap-200">
            <Button variant="ghost" onClick={() => setWire((w) => !w)}>
              {wire ? 'Hide wire ▾' : 'Show wire ▸'}
            </Button>
            <Button variant="secondary" disabled={keys.length === 0 || props.busy} onClick={props.onDiscard}>
              Discard
            </Button>
            <Button variant="primary" disabled={keys.length === 0 || props.busy} onClick={props.onApply}>
              {keys.length ? `Apply → ${target}` : 'Apply'}
            </Button>
          </div>
        </div>
      </div>
      {wire && (
        <div className="grid grid-cols-1 gap-gap-300 lg:grid-cols-2">
          <Wire
            title={keys.length || !props.lastFrame ? `WebSocket frame → ${props.liveCalls} live calls` : 'WebSocket frame last sent'}
            body={frame ? JSON.stringify(frame, null, 2) : 'No live changes staged.'}
          />
          <Wire title="Next call’s TwiML" body={twimlPreview(props.staged)} />
        </div>
      )}
    </>
  );
}

function Wire({ title, body }: { readonly title: string; readonly body: string }) {
  return (
    <div className="flex flex-col gap-gap-100">
      <Typography variant="body-xs-semibold" className="text-text-secondary">
        {title}
      </Typography>
      <pre className="overflow-x-auto rounded-sm bg-surface-field p-3">
        <Typography variant="mono-s-regular">{body}</Typography>
      </pre>
    </div>
  );
}

/** The inline name field "Save as preset" opens. `onSave` resolves to an error message, or `null` on success. */
function SavePreset({ onSave }: { readonly onSave: (name: string) => Promise<string | null> }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    setOpen(false);
    setName('');
    setError(null);
  };
  const submit = async () => {
    const err = await onSave(name.trim());
    if (err === null) close();
    else setError(err);
  };

  if (!open) {
    return (
      <Button variant="ghost" onClick={() => setOpen(true)}>
        Save as preset
      </Button>
    );
  }
  return (
    <span className="flex items-center gap-gap-200">
      <Input
        aria-label="Preset name"
        placeholder="Preset name"
        autoFocus
        value={name}
        state={error ? 'error' : undefined}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && name.trim()) void submit();
          if (e.key === 'Escape') close();
        }}
        containerClassName="w-56"
        className="w-56"
      />
      <Button variant="primary" disabled={!name.trim()} onClick={() => void submit()}>
        Save
      </Button>
      <Button variant="ghost" onClick={close}>
        Cancel
      </Button>
      {error && (
        <Typography variant="body-xs" className="text-text-error">
          {error}
        </Typography>
      )}
    </span>
  );
}

/** Profile chip and preset controls. Loading a preset stages only the keys it defines. */
function ProfileHeader(props: {
  readonly rev: number;
  readonly source: string;
  readonly presets: readonly Preset[];
  readonly onLoad: (p: Preset) => void;
  readonly onSave: (name: string) => Promise<string | null>;
}) {
  return (
    <div className="flex flex-col gap-gap-200 md:flex-row md:items-center md:justify-between">
      <div className="flex items-center gap-gap-300">
        <Typography variant="h4" as="h1">
          ConversationRelay tuning
        </Typography>
      </div>
      <div className="flex flex-wrap items-center gap-gap-200">
        <Badge label={`rev ${props.rev}`} variant="brand10" />
        <Typography variant="body-s" className="text-text-secondary">
          {props.source}
        </Typography>
        <NativeSelect
          aria-label="Load preset"
          value=""
          onChange={(e) => {
            const p = props.presets.find((x) => x.name === e.target.value);
            if (p) props.onLoad(p);
          }}
          containerClassName="w-64"
        >
          <NativeSelectOption value="">Stage a preset…</NativeSelectOption>
          {props.presets.map((p) => (
            <NativeSelectOption key={p.name} value={p.name}>
              {p.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <SavePreset onSave={props.onSave} />
      </div>
    </div>
  );
}

/** A call tab's label: live dot and running timer, or when it ended, plus a marker while an Apply awaits confirmation. */
function CallTabLabel({ call }: { readonly call: CallSummary }) {
  return (
    <span className="flex items-center gap-gap-100">
      {call.live && <span className="inline-block h-2 w-2 rounded-full bg-surface-success" />}
      <span className="font-mono">{call.sid.slice(0, 6)}</span>
      {call.live ? <CallTimer seconds={call.elapsedS} isRunning /> : <span>{endedAgo(call.endedAt)}</span>}
      {call.applying && <Badge label="applying" variant="warning" size="small" />}
    </span>
  );
}

/** The call workspace when there are no calls to show. */
function NoCalls({ loaded, phone }: { readonly loaded: boolean; readonly phone: string | null }) {
  if (!loaded) {
    return (
      <Typography variant="body-s" as="p" className="text-text-tertiary">
        Loading calls…
      </Typography>
    );
  }
  return (
    <div className="flex flex-col gap-gap-200">
      <Typography variant="body-m-semibold" as="p">
        No calls yet
      </Typography>
      <Typography variant="body-s" as="p" className="text-text-secondary">
        {phone ? (
          <>
            Call{' '}
            <a className="text-text-accent underline underline-offset-2" href={`tel:${phone}`}>
              {formatPhone(phone)}
            </a>{' '}
            to start one.
          </>
        ) : (
          'Call the demo number to start one.'
        )}{' '}
        It appears here as a tab while it is live, and each Apply shows up on its timeline.
      </Typography>
    </div>
  );
}

/** The CR tuning page: settings rail, sticky Apply bar, and per-call timelines, on the agent's live data. */
export function TuningClient() {
  const [applied, setApplied] = useState<Profile>(TWILIO_DEFAULTS);
  const [staged, setStaged] = useState<Profile>(TWILIO_DEFAULTS);
  const [rev, setRev] = useState(0);
  const [source, setSource] = useState('');
  const [stagedPreset, setStagedPreset] = useState<string | null>(null);
  const [presets, setPresets] = useState<readonly Preset[]>(PRESETS);
  const [calls, setCalls] = useState<readonly CallSummary[]>([]);
  const [timelines, setTimelines] = useState<Readonly<Record<string, CallTimeline>>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [lastApply, setLastApply] = useState<{ readonly response: ApplyResponse; readonly at: number } | null>(null);
  const [crErrors, setCrErrors] = useState<readonly ReceivedError[]>([]);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [phone, setPhone] = useState<string | null>(null);

  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;
  const sidByConversation = useRef(new Map<string, string>());
  const queue = useRef<{ sids: Set<string>; timer: ReturnType<typeof setTimeout> | null }>({ sids: new Set(), timer: null });

  const takeState = (s: TuningState, resetStaged: boolean) => {
    setApplied(s.profile);
    if (resetStaged) setStaged(s.profile);
    setRev(s.rev);
    setSource(s.source);
    setPresets(s.presets);
    sidByConversation.current = new Map(s.liveCalls.map((l) => [l.conversationId, l.sid]));
  };

  const loadTimeline = async (sid: string) => {
    const t = await api<CallTimeline>(callTimelinePath(sid));
    setTimelines((m) => ({ ...m, [sid]: t }));
  };

  const takeCalls = (list: readonly CallSummary[], live: readonly LiveCall[]) => {
    setCalls(list);
    setSelected((cur) => (cur && list.some((c) => c.sid === cur) ? cur : defaultSelection(list, live)));
  };

  const refresh = async (eventSids: readonly string[]) => {
    try {
      const [s, list] = await Promise.all([api<TuningState>(TUNING_PATH), api<CallsResponse>(CALLS_PATH)]);
      takeState(s, false);
      takeCalls(list.calls, s.liveCalls);
      setLoadError(null);
      const sids = new Set(eventSids.map((id) => sidByConversation.current.get(id) ?? id).filter((id) => list.calls.some((c) => c.sid === id)));
      if (sids.size === 0 && selectedRef.current) sids.add(selectedRef.current);
      await Promise.allSettled([...sids].map(loadTimeline));
    } catch (e) {
      setLoadError(message(e));
    }
  };

  const schedule = (id: string | null) => {
    const q = queue.current;
    if (id) q.sids.add(id);
    if (q.timer) return;
    q.timer = setTimeout(() => {
      const sids = [...q.sids];
      q.sids.clear();
      q.timer = null;
      void refresh(sids);
    }, REFRESH_DEBOUNCE_MS);
  };

  useEffect(() => {
    void (async () => {
      try {
        const [s, list] = await Promise.all([api<TuningState>(TUNING_PATH), api<CallsResponse>(CALLS_PATH)]);
        takeState(s, true);
        takeCalls(list.calls, s.liveCalls);
        await Promise.allSettled(list.calls.map((c) => loadTimeline(c.sid)));
      } catch (e) {
        setLoadError(message(e));
      } finally {
        setLoaded(true);
      }
    })();
    fetch('/health')
      .then((r) => (r.ok ? (r.json() as Promise<{ readonly phoneNumber?: string | null }>) : null))
      .then((h) => setPhone(h?.phoneNumber ?? null))
      .catch(() => setPhone(null));
  }, []);

  useEffect(() => {
    const feed = new EventSource(SSE_PATH);
    feed.addEventListener('obs', (m) => {
      const event = JSON.parse((m as MessageEvent<string>).data) as ObsEvent;
      if (!REFRESH_KINDS.has(event.kind)) return;
      if (event.kind === 'turn.end' && event.channel !== 'voice') return;
      const callSid = typeof event.payload?.callSid === 'string' ? event.payload.callSid : null;
      if (event.kind === 'cr.config.error' && callSid) {
        const payload = event.payload as unknown as CrConfigErrorPayload;
        setCrErrors((es) => [...es, { payload, at: Date.parse(event.at) }]);
      }
      schedule(callSid ?? event.conversationId ?? null);
    });
    return () => {
      feed.close();
      if (queue.current.timer) clearTimeout(queue.current.timer);
      queue.current.timer = null;
    };
  }, []);

  const selectedCall = calls.find((c) => c.sid === selected);
  const selectedTimeline = selected ? timelines[selected] : undefined;
  const poll = selectedCall?.live === true || (selectedTimeline !== undefined && selectedTimeline.insights !== 'complete');

  useEffect(() => {
    if (!selected) return;
    void loadTimeline(selected).catch(() => undefined);
    if (!poll) return;
    const id = setInterval(() => void loadTimeline(selected).catch(() => undefined), POLL_MS);
    return () => clearInterval(id);
  }, [selected, poll]);

  const liveCount = calls.filter((c) => c.live).length;
  const receipt = lastApply && receiptFor(lastApply, timelines, crErrors);
  const lastFrame = lastApply?.response.calls.find((c) => c.frame !== null)?.frame ?? null;
  const loadedTimelines = calls.flatMap((c) => (timelines[c.sid] ? [timelines[c.sid]!] : []));

  const change = (key: string, v: string) => {
    setApplyError(null);
    setStaged((s) => {
      const next = { ...s, [key]: v };
      for (const p of PARAMS) if (p.optionsBy?.key === key) next[p.key] = p.optionsBy.map[v]?.[0] ?? '';
      return next;
    });
  };

  const apply = async () => {
    const profile = staged;
    const body: ApplyRequest = { profile, preset: stagedPreset };
    setBusy(true);
    setApplyError(null);
    try {
      const r = await api<ApplyResponse>(TUNING_APPLY_PATH, { method: 'POST', body });
      setApplied(profile);
      setRev(r.rev);
      setSource(r.source);
      setStagedPreset(null);
      setLastApply({ response: r, at: Date.now() });
      const reached = r.calls.filter((c) => c.sent).map((c) => c.sid);
      if (reached[0]) setSelected(reached[0]);
      await Promise.allSettled(reached.map(loadTimeline));
    } catch (e) {
      setApplyError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const savePreset = async (name: string): Promise<string | null> => {
    const body: SavePresetRequest = { values: staged };
    try {
      const r = await api<SavePresetResponse>(tuningPresetPath(name), { method: 'PUT', body });
      setPresets(r.presets);
      return null;
    } catch (e) {
      return message(e);
    }
  };

  return (
    <div className="flex flex-col gap-gap-300">
      <ProfileHeader
        rev={rev}
        source={source}
        presets={presets}
        onLoad={(p) => {
          setApplyError(null);
          setStaged((s) => ({ ...s, ...p.values }));
          setStagedPreset(p.name);
        }}
        onSave={savePreset}
      />

      {loadError && (
        <Typography variant="body-s" as="p" className="text-text-error">
          The agent did not answer ({loadError}), so the settings below may not be the live profile and Apply will fail.
        </Typography>
      )}

      <ApplyBar
        applied={applied}
        staged={staged}
        stagedPreset={stagedPreset}
        receipt={receipt}
        lastFrame={lastFrame}
        liveCalls={liveCount}
        busy={busy}
        error={applyError}
        onApply={() => void apply()}
        onDiscard={() => {
          setStaged(applied);
          setStagedPreset(null);
          setApplyError(null);
        }}
      />

      <div className="grid grid-cols-1 gap-gap-400 xl:grid-cols-12">
        <div className="flex flex-col gap-gap-300 xl:col-span-5">
          <a href={DYNAMIC_CONFIG_URL} target="_blank" rel="noreferrer" className="flex items-center gap-gap-100 px-2 text-text-accent underline underline-offset-2">
            <Typography variant="body-xs-semibold">How mid-call timing works — dynamic configuration docs</Typography>
            <ExternalLinkIcon size="xs" />
          </a>
          {GROUPS.map((g) => (
            <GroupCard key={g.id} group={g.id} title={g.title} applied={applied} staged={staged} onChange={change} />
          ))}
        </div>

        <div className="xl:col-span-7">
          <Card variant="elevated" padding="md" className="xl:sticky xl:top-24">
            {calls.length === 0 ? (
              <NoCalls loaded={loaded} phone={phone} />
            ) : (
              <Tabs
                aria-label="Calls"
                value={selected ?? ''}
                onValueChange={setSelected}
                rootClassName="w-full"
                panelClassName="w-full"
                items={calls.map((c) => ({
                  value: c.sid,
                  label: <CallTabLabel call={c} />,
                  content: timelines[c.sid] ? (
                    <CallView call={timelines[c.sid]!} calls={loadedTimelines} />
                  ) : (
                    <Typography variant="body-s" as="p" className="pt-3 text-text-tertiary">
                      Loading timeline…
                    </Typography>
                  ),
                }))}
              />
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
