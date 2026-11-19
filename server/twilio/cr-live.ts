import { randomUUID } from 'node:crypto';
import {
  configFrame,
  diffKeys,
  isLiveKey,
  param,
  PARAMS,
  relayAttributes,
  type ConfigFrame,
  type Profile,
  type Timing,
  type WireValue,
} from '../../shared/cr-params.ts';
import type {
  Apply,
  ApplyCallResult,
  ApplyRequest,
  ApplyResponse,
  CallSummary,
  CallsResponse,
  CallTimeline,
  ConfigChange,
  CrConfigApplyPayload,
  CrConfigErrorPayload,
  CrConfigUpdatedPayload,
  InsightsStatus,
  LiveCall,
  ProfileChange,
  SavePresetResponse,
  Turn,
  TuningState,
} from '../../shared/tuning-api.ts';
import type { ObsBus } from '../obs/bus.ts';
import { maskPhone } from '../obs/pii.ts';
import { startSpanUnder, type SpanLike } from '../obs/spans.ts';
import type { ClosedTurn } from '../obs/voice-timeline.ts';
import { insightsTurns, type InsightsCall, type InsightsClient, type InsightsTurn } from './cr-insights.ts';
import type { ProfileStore } from './cr-store.ts';
import type { InsightsBackfill, RootContext } from './insights-backfill.ts';

/** The two members of a ConversationRelay socket the registry uses. */
export interface ConfigSocket {
  send(data: string): void;
  readonly readyState: number;
}

/** How the registry reaches the voice channel's trace roots. */
export interface VoiceTraces {
  /** Returns the traceparent of the call's root span, opening it if needed. */
  readonly traceparentFor: (conversationId: string) => string | undefined;
  /** True when TAC uses the CallSid as the conversation id (no Conversation Orchestrator). */
  readonly conversationIdIsCallSid: boolean;
  /** The call's root context without opening a root, or `undefined` when there is none. */
  readonly rootContextFor?: (callSid: string) => RootContext | undefined;
}

/** Per-process ConversationRelay tuning: the saved profile, the live calls and their timelines. */
export interface CrTuning {
  /** `GET /api/tuning`. */
  state(): TuningState;
  /** `POST /api/tuning/apply`: saves the profile as the next revision and sends one `config` frame to every live call. */
  apply(req: ApplyRequest): ApplyResponse;
  /** `PUT /api/tuning/presets/:name`. */
  savePreset(name: string, values: Profile): SavePresetResponse;
  /** `GET /api/calls`. */
  calls(): CallsResponse;
  /** `GET /api/calls/:callSid/timeline`, or `null` for a call this process has not seen. */
  timeline(callSid: string): Promise<CallTimeline | null>;
  /** Returns the next call's `<ConversationRelay>` attributes and records the revision call `callSid` starts on. */
  nextCallTwiml(callSid: string | undefined): Record<string, WireValue>;
  /** Registers a newly accepted ConversationRelay socket. */
  socketOpened(ws: ConfigSocket): void;
  /** Handles one raw inbound frame on `ws`: `setup`, `info`/`configUpdated` and `error` are read, the rest ignored. */
  socketMessage(ws: ConfigSocket, raw: string): void;
  /** Marks the call on `ws` as ended. */
  socketClosed(ws: ConfigSocket): void;
  /** Associates TAC's conversation id with a call and emits any spans held until then. */
  bindConversation(callSid: string, conversationId: string): void;
  /** Records a turn start and writes `cr.config.revision` onto its span. */
  turnBegan(conversationId: string, span: Pick<SpanLike, 'update'>, atMs: number): void;
  /** Records a closed turn. */
  turnEnded(conversationId: string, turn: ClosedTurn): void;
  /** Supplies the voice channel's trace roots; spans are held until this is called. */
  connectVoice(traces: VoiceTraces): void;
}

export interface CrTuningOptions {
  readonly store: ProfileStore;
  readonly bus: ObsBus;
  readonly insights: InsightsClient | null;
  /** Receives every ended call that has a conversation id. */
  readonly backfill?: Pick<InsightsBackfill, 'callEnded'> | null;
  /** Ended calls kept for `GET /api/calls`. Default 10. */
  readonly maxEnded?: number;
  /** ms an incomplete Voice Insights fetch is reused for. Default 15000. */
  readonly insightsTtlMs?: number;
  readonly now?: () => number;
}

const WS_OPEN = 1;

interface ApplyRecord extends Omit<Apply, 'changes'> {
  readonly sentAtMs: number;
  readonly changes: ConfigChange[];
  rejected: string | null;
}

interface AgentTurn {
  readonly n: number;
  readonly promptAt: number;
  readonly firstTokenAt: number | null;
  readonly endAt: number;
  readonly interrupted: boolean;
  readonly revStart: number;
  readonly revEnd: number;
}

interface CallRecord {
  readonly sid: string;
  readonly from: string;
  readonly ws: ConfigSocket;
  readonly startedAtMs: number;
  endedAtMs: number | null;
  conversationId: string | null;
  readonly startRev: number;
  rev: number;
  readonly startProfile: Profile;
  readonly effective: Record<string, string>;
  readonly applies: ApplyRecord[];
  readonly turns: AgentTurn[];
  liveTurn: { readonly n: number; readonly revStart: number } | null;
  turnsBegun: number;
  initialEvents: number;
  readonly pendingSpans: (() => void)[];
  insights: { readonly at: number; readonly data: InsightsCall | null; readonly error: string | null } | null;
}

const ELEVENLABS_SUFFIXES = (param('elevenlabsModel').options ?? []).filter((o) => o !== 'default');

const canonical = (key: string, raw: string): string => {
  const p = PARAMS.find((x) => x.key === key);
  if (p === undefined) return raw;
  if (p.wire === 'boolean') return raw.toLowerCase();
  const options = p.options ?? Object.values(p.optionsBy?.map ?? {}).flat();
  return options.find((o) => o.toLowerCase() === raw.toLowerCase()) ?? raw;
};

/** Flattens a `configUpdated` value's `session` and `language` entries into attribute → string. */
const flatten = (value: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  const put = (obj: unknown): void => {
    if (obj === null || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      if (k !== 'code' && v !== null && typeof v !== 'object') out[k] = String(v);
    }
  };
  const v = (value ?? {}) as { session?: unknown; language?: unknown };
  put(v.session);
  for (const lang of Array.isArray(v.language) ? v.language : [v.language]) put(lang);
  return out;
};

const overlay = (effective: Record<string, string>, delta: Record<string, string>): void => {
  for (const key of ['ttsProvider', ...Object.keys(delta).filter((k) => k !== 'ttsProvider')]) {
    const raw = delta[key];
    if (raw === undefined || !PARAMS.some((p) => p.key === key)) continue;
    if (key === 'voice') {
      const suffix = ELEVENLABS_SUFFIXES.find((s) => raw.endsWith(`-${s}`));
      effective.voice = suffix === undefined ? raw : raw.slice(0, -suffix.length - 1);
      if (effective.ttsProvider === 'ElevenLabs') effective.elevenlabsModel = suffix ?? 'default';
    } else {
      effective[key] = canonical(key, raw);
    }
  }
};

const covers = (deltaKey: string, changeKey: string): boolean =>
  deltaKey === changeKey || (deltaKey === 'voice' && changeKey === 'elevenlabsModel');

const wall = (ms: number): string => new Date(ms).toTimeString().slice(0, 8);

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
};

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Creates the tuning registry. */
export function createCrTuning(opts: CrTuningOptions): CrTuning {
  const { store, bus } = opts;
  const now = opts.now ?? Date.now;
  const maxEnded = opts.maxEnded ?? 10;
  const insightsTtlMs = opts.insightsTtlMs ?? 15_000;

  let traces: VoiceTraces | null = null;
  const bySocket = new Map<ConfigSocket, CallRecord | null>();
  const bySid = new Map<string, CallRecord>();
  const byConversation = new Map<string, CallRecord>();
  const ended: CallRecord[] = [];
  const nextCallStarts = new Map<string, { rev: number; profile: Profile }>();

  const live = (): CallRecord[] =>
    [...bySid.values()].filter((c) => c.endedAtMs === null).sort((a, b) => b.startedAtMs - a.startedAtMs);

  const pending = (c: CallRecord): boolean =>
    c.applies.some((a) => a.rejected === null && a.changes.some((ch) => ch.effectiveAt === null));

  const summary = (c: CallRecord): CallSummary => ({
    sid: c.sid,
    from: maskPhone(c.from),
    live: c.endedAtMs === null,
    startedAt: new Date(c.startedAtMs).toISOString(),
    endedAt: c.endedAtMs === null ? null : new Date(c.endedAtMs).toISOString(),
    elapsedS: Math.round(((c.endedAtMs ?? now()) - c.startedAtMs) / 1000),
    startRev: c.startRev,
    applying: pending(c),
  });

  const liveCall = (c: CallRecord): LiveCall => ({
    ...summary(c),
    conversationId: c.conversationId ?? '',
    rev: c.rev,
    effective: { ...c.effective },
  });

  const span = (c: CallRecord, name: string, metadata: Record<string, unknown>, atMs: number): void => {
    const fire = (): void => {
      if (traces === null || c.conversationId === null) return;
      startSpanUnder(traces.traceparentFor(c.conversationId), name, { metadata }, atMs).end(atMs);
    };
    if (traces === null || c.conversationId === null) c.pendingSpans.push(fire);
    else fire();
  };

  const firstTurnFor = (c: CallRecord, timing: Timing): number =>
    c.liveTurn !== null && (timing === 'now' || timing === 'next-reply') ? c.liveTurn.n : c.turnsBegun + 1;

  const onSetup = (ws: ConfigSocket, msg: { callSid?: unknown; from?: unknown }): void => {
    const sid = String(msg.callSid ?? '');
    const start = nextCallStarts.get(sid) ?? { rev: store.current().rev, profile: store.current().profile };
    nextCallStarts.delete(sid);
    const rec: CallRecord = {
      sid,
      from: String(msg.from ?? ''),
      ws,
      startedAtMs: now(),
      endedAtMs: null,
      conversationId: null,
      startRev: start.rev,
      rev: start.rev,
      startProfile: start.profile,
      effective: { ...start.profile },
      applies: [],
      turns: [],
      liveTurn: null,
      turnsBegun: 0,
      initialEvents: 0,
      pendingSpans: [],
      insights: null,
    };
    bySocket.set(ws, rec);
    bySid.set(sid, rec);
    if (traces?.conversationIdIsCallSid === true) bind(rec, sid);
  };

  const bind = (rec: CallRecord, conversationId: string): void => {
    rec.conversationId = conversationId;
    byConversation.set(conversationId, rec);
    if (traces === null) return;
    for (const fire of rec.pendingSpans.splice(0)) fire();
  };

  const onConfigUpdated = (c: CallRecord, value: unknown): void => {
    const at = now();
    const delta = flatten(value);
    const initial = c.applies.length === 0 && c.initialEvents < 3;
    if (initial) c.initialEvents += 1;
    overlay(c.effective, delta);

    let matched: ApplyRecord | null = null;
    for (const a of c.applies) {
      a.changes.forEach((ch, i) => {
        if (ch.effectiveAt !== null || !Object.keys(delta).some((k) => covers(k, ch.key))) return;
        a.changes[i] = { ...ch, effectiveAt: at - c.startedAtMs, firstTurn: firstTurnFor(c, ch.timing) };
        matched = a;
      });
    }
    const hit = matched as ApplyRecord | null;
    const sinceApplyMs = hit === null ? null : at - hit.sentAtMs;
    span(
      c,
      'cr.config.updated',
      {
        'cr.config.delta': JSON.stringify(value ?? {}),
        'cr.config.apply_id': hit?.applyId ?? null,
        'cr.config.since_apply_ms': sinceApplyMs,
        'cr.config.initial': initial,
      },
      at,
    );
    const payload: CrConfigUpdatedPayload = {
      callSid: c.sid,
      delta: (value ?? {}) as Record<string, unknown>,
      applyId: hit?.applyId ?? null,
      sinceApplyMs,
      initial,
    };
    bus.publish({
      kind: 'cr.config.updated',
      summary: initial
        ? `starting config: ${Object.keys(delta).join(', ')}`
        : `config in effect${sinceApplyMs === null ? '' : ` after ${sinceApplyMs} ms`}: ${Object.keys(delta).join(', ')}`,
      channel: 'voice',
      conversationId: c.conversationId ?? c.sid,
      ...(sinceApplyMs !== null && { durationMs: sinceApplyMs }),
      payload: { ...payload },
    });
  };

  const onError = (c: CallRecord, description: string): void => {
    const at = now();
    const target = [...c.applies].reverse().find((a) => a.rejected === null && a.changes.some((ch) => ch.effectiveAt === null));
    if (target !== undefined) target.rejected = description;
    const applyId = target?.applyId ?? null;
    span(c, 'cr.config.error', { 'cr.config.error': description, 'cr.config.apply_id': applyId }, at);
    const payload: CrConfigErrorPayload = { callSid: c.sid, description, applyId };
    bus.publish({
      kind: 'cr.config.error',
      summary: `ConversationRelay rejected config: ${description}`,
      channel: 'voice',
      conversationId: c.conversationId ?? c.sid,
      payload: { ...payload },
    });
  };

  const sourceOf = (preset: string | null, keys: readonly string[]): string => {
    if (preset === null) return plural(keys.length, 'manual edit');
    const values = store.presets().find((p) => p.name === preset)?.values ?? {};
    const edits = keys.filter((k) => values[k] === undefined).length;
    return edits === 0 ? `from ${preset}` : `from ${preset}, ${plural(edits, 'edit')}`;
  };

  const sendTo = (
    c: CallRecord,
    frame: ConfigFrame | null,
    meta: { applyId: string; rev: number; preset: string | null; changes: readonly ProfileChange[]; nextCall: readonly string[]; profile: Profile },
  ): ApplyCallResult => {
    const at = now();
    let sent = false;
    let error: string | null = null;
    if (frame !== null) {
      if (c.ws.readyState !== WS_OPEN) error = 'socket not open';
      else {
        try {
          c.ws.send(JSON.stringify(frame));
          sent = true;
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }
      }
    }
    const liveChanges = meta.changes.filter((ch) => isLiveKey(ch.key, meta.profile));
    c.applies.push({
      applyId: meta.applyId,
      rev: meta.rev,
      wall: wall(at),
      at: at - c.startedAtMs,
      sentAtMs: at,
      preset: meta.preset,
      nextCall: meta.nextCall,
      rejected: null,
      changes: sent
        ? liveChanges.map((ch) => {
            const already = c.effective[ch.key] === meta.profile[ch.key];
            return { ...ch, effectiveAt: already ? at - c.startedAtMs : null, firstTurn: already ? firstTurnFor(c, ch.timing) : null };
          })
        : [],
    });
    if (sent && frame !== null) {
      c.rev = meta.rev;
      span(
        c,
        'cr.config.apply',
        {
          'cr.config.apply_id': meta.applyId,
          'cr.config.revision': meta.rev,
          'cr.config.changes': JSON.stringify(liveChanges),
          'cr.config.frame': JSON.stringify(frame),
        },
        at,
      );
      const payload: CrConfigApplyPayload = { callSid: c.sid, applyId: meta.applyId, rev: meta.rev, changes: liveChanges, frame };
      bus.publish({
        kind: 'cr.config.apply',
        summary: `config rev ${meta.rev} sent: ${liveChanges.map((ch) => ch.key).join(', ')}`,
        channel: 'voice',
        conversationId: c.conversationId ?? c.sid,
        payload: { ...payload },
      });
    }
    return { sid: c.sid, conversationId: c.conversationId ?? '', frame, sent, error };
  };

  const loadInsights = async (c: CallRecord): Promise<void> => {
    if (opts.insights === null) return;
    const cached = c.insights;
    const complete = cached?.data !== null && cached?.data !== undefined && c.endedAtMs !== null && insightsTurns(cached.data.events).wrappedUp;
    if (cached !== null && (complete || now() - cached.at < insightsTtlMs)) return;
    try {
      c.insights = { at: now(), data: await opts.insights.fetch(c.sid), error: null };
    } catch (err) {
      c.insights = { at: now(), data: null, error: err instanceof Error ? err.message : String(err) };
    }
  };

  const buildTimeline = (c: CallRecord): CallTimeline => {
    const start = c.startedAtMs;
    const endMs = c.endedAtMs ?? now();
    const parsed = c.insights?.data ? insightsTurns(c.insights.data.events) : null;
    const ins: readonly InsightsTurn[] = parsed?.turns ?? [];
    const pairs = Math.min(ins.length, c.turns.length);
    const offset = median(
      Array.from({ length: pairs }, (_, i) => (c.turns[i] as AgentTurn).promptAt - (ins[i] as InsightsTurn).promptSent),
    ) ?? 0;
    const shift = (t: number): number => t + offset - start;

    const greeting = c.startProfile.welcomeGreeting ?? '';
    const greetingEnd = parsed?.greetingEnd != null ? shift(parsed.greetingEnd) : 400 + greeting.length * 65;

    let prevEnd = greetingEnd;
    let filled = 0;
    const turns: Turn[] = c.turns.map((t, i) => {
      const sttEnd = t.promptAt - start;
      const firstToken = (t.firstTokenAt ?? t.endAt) - start;
      const agentEnd = t.endAt - start;
      const it = ins[i];
      const full = it !== undefined && it.audioStart !== null && it.audioEnd !== null;
      if (full) filled += 1;
      const utteranceEnd = full ? Math.min(shift(it.utteranceEnd), sttEnd) : sttEnd;
      const turn: Turn = {
        n: t.n,
        callerStart: full ? Math.min(shift(it.callerStart ?? it.utteranceEnd), utteranceEnd) : Math.min(prevEnd, sttEnd),
        utteranceEnd,
        sttEnd,
        firstToken,
        audioStart: full ? Math.max(shift(it.audioStart as number), firstToken) : firstToken,
        audioEnd: full ? Math.max(shift(it.audioEnd as number), firstToken) : agentEnd,
        interrupted: full ? it.interrupted : t.interrupted,
        rev: t.revStart === t.revEnd ? String(t.revStart) : `${t.revStart}→${t.revEnd}`,
        insights: full,
      };
      prevEnd = turn.audioEnd;
      return turn;
    });

    const status: InsightsStatus =
      parsed === null || parsed.turns.length === 0 ? 'pending' : filled === c.turns.length && parsed.wrappedUp ? 'complete' : 'partial';

    const sttAvg = c.insights?.data?.summary ? (c.insights.data.summary.stt_latency_ms as { avg?: number } | undefined)?.avg : undefined;
    const sttOurs = ins.map((t) => t.sttMs).filter((x): x is number => x !== null);
    const sttMean = sttOurs.length ? Math.round(sttOurs.reduce((a, b) => a + b, 0) / sttOurs.length) : null;
    const lag = c.endedAtMs === null ? 'Live. ' : 'Ended. ';
    const note =
      c.insights?.error != null
        ? `${lag}App lane from this agent; Voice Insights fetch failed: ${c.insights.error}.`
        : status === 'pending'
          ? `${lag}App lane from this agent; caller, STT and TTS pending Voice Insights.`
          : `${lag}App lane from this agent; caller, STT and TTS from Voice Insights Events (${filled}/${c.turns.length} turns, clock offset ${Math.round(offset)} ms${
              sttAvg !== undefined && sttMean !== null ? `, STT avg ${sttMean} ms vs Summary ${sttAvg} ms` : ''
            }).`;

    return {
      ...summary(c),
      greetingEnd,
      durationMs: endMs - start,
      turns,
      applies: c.applies.map(({ sentAtMs: _sentAtMs, rejected: _rejected, ...a }) => a),
      insights: status,
      insightsNote: note,
    };
  };

  return {
    state: () => {
      const saved = store.current();
      return { profile: saved.profile, rev: saved.rev, source: saved.source, presets: store.presets(), liveCalls: live().map(liveCall) };
    },

    apply(req) {
      const saved = store.current();
      const profile: Record<string, string> = {};
      for (const p of PARAMS) profile[p.key] = req.profile[p.key] ?? saved.profile[p.key] ?? '';
      profile.events = 'config-updated';
      const keys = diffKeys(saved.profile, profile);
      const preset = req.preset ?? null;
      if (keys.length === 0) {
        return { rev: saved.rev, applyId: '', source: saved.source, changes: [], nextCall: [], calls: [] };
      }
      const changes: ProfileChange[] = keys.map((key) => ({
        key,
        from: saved.profile[key] ?? '',
        to: profile[key] ?? '',
        timing: param(key).timing,
      }));
      const nextCall = changes.filter((ch) => ch.timing === 'next-call').map((ch) => ch.key);
      const rev = saved.rev + 1;
      const source = sourceOf(preset, keys);
      store.commit({ profile, rev, source });
      const applyId = randomUUID();
      const frame = configFrame(keys, profile);
      const calls = live().map((c) => sendTo(c, frame, { applyId, rev, preset, changes, nextCall, profile }));
      return { rev, applyId, source, changes, nextCall, calls };
    },

    savePreset: (name, values) => ({ presets: store.savePreset(name, values) }),

    calls: () => ({
      calls: [...live(), ...[...ended].sort((a, b) => b.startedAtMs - a.startedAtMs)].map(summary),
    }),

    async timeline(callSid) {
      const c = bySid.get(callSid);
      if (c === undefined) return null;
      await loadInsights(c);
      return buildTimeline(c);
    },

    nextCallTwiml(callSid) {
      const saved = store.current();
      if (callSid !== undefined) {
        nextCallStarts.set(callSid, { rev: saved.rev, profile: saved.profile });
        while (nextCallStarts.size > 50) nextCallStarts.delete(nextCallStarts.keys().next().value as string);
      }
      return relayAttributes(saved.profile);
    },

    socketOpened(ws) {
      bySocket.set(ws, null);
    },

    socketMessage(ws, raw) {
      let msg: { type?: unknown; name?: unknown; value?: unknown; description?: unknown; callSid?: unknown; from?: unknown };
      try {
        msg = JSON.parse(raw) as typeof msg;
      } catch {
        return;
      }
      if (msg.type === 'setup') return onSetup(ws, msg);
      const c = bySocket.get(ws);
      if (c === null || c === undefined) return;
      if (msg.type === 'info' && msg.name === 'configUpdated') onConfigUpdated(c, msg.value);
      else if (msg.type === 'error') onError(c, String(msg.description ?? ''));
    },

    socketClosed(ws) {
      const c = bySocket.get(ws);
      bySocket.delete(ws);
      if (c === null || c === undefined) return;
      c.endedAtMs = now();
      if (opts.backfill && traces !== null && c.conversationId !== null) {
        const root = traces.rootContextFor?.(c.sid) ?? {
          traceparent: traces.traceparentFor(c.conversationId),
          sessionId: c.conversationId,
        };
        void opts.backfill.callEnded(c.sid, root);
      }
      ended.push(c);
      while (ended.length > maxEnded) {
        const old = ended.shift() as CallRecord;
        bySid.delete(old.sid);
        if (old.conversationId !== null && byConversation.get(old.conversationId) === old) byConversation.delete(old.conversationId);
      }
    },

    bindConversation(callSid, conversationId) {
      const c = bySid.get(callSid);
      if (c !== undefined && c.conversationId !== conversationId) bind(c, conversationId);
    },

    turnBegan(conversationId, turnSpan, _atMs) {
      const c = byConversation.get(conversationId);
      if (c === undefined) return;
      c.turnsBegun += 1;
      c.liveTurn = { n: c.turnsBegun, revStart: c.rev };
      turnSpan.update({ metadata: { 'cr.config.revision': c.rev } });
    },

    turnEnded(conversationId, turn) {
      const c = byConversation.get(conversationId);
      if (c === undefined) return;
      const n = c.liveTurn?.n ?? c.turnsBegun;
      c.turns.push({
        n,
        promptAt: turn.promptAt,
        firstTokenAt: turn.firstTokenAt,
        endAt: turn.endAt,
        interrupted: turn.ending === 'interrupt',
        revStart: c.liveTurn?.revStart ?? c.rev,
        revEnd: c.rev,
      });
      c.liveTurn = null;
    },

    connectVoice(next) {
      traces = next;
      for (const c of bySid.values()) {
        if (c.conversationId === null && next.conversationIdIsCallSid) bind(c, c.sid);
        else if (c.conversationId !== null) for (const fire of c.pendingSpans.splice(0)) fire();
      }
    },
  };
}
