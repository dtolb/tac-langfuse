import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import twilio from 'twilio';
import {
  context,
  propagation,
  ROOT_CONTEXT,
  trace,
  TraceFlags,
  type Context,
  type ContextManager,
  type TextMapGetter,
  type TextMapSetter,
} from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { setLangfuseTracerProvider } from '@langfuse/tracing';
import type { ObsEvent } from '../shared/events.ts';
import { TWILIO_DEFAULTS } from '../shared/cr-params.ts';
import {
  callTimelinePath,
  CALLS_PATH,
  TUNING_APPLY_PATH,
  TUNING_PATH,
  type ApplyResponse,
  type CallsResponse,
  type CallTimeline,
  type TuningState,
} from '../shared/tuning-api.ts';
import { capabilities, loadConfig } from '../server/config.ts';
import { buildApp } from '../server/http/app.ts';
import { createObsBus } from '../server/obs/bus.ts';
import { createCrTuning } from '../server/twilio/cr-live.ts';
import { createProfileStore } from '../server/twilio/cr-store.ts';
import { bootTac, type TacHandle } from '../server/twilio/tac.ts';
import { fakeTurnDeps } from './helpers/fake-voice.ts';

const storage = new AsyncLocalStorage<Context>();
const contextManager: ContextManager = {
  active: () => storage.getStore() ?? ROOT_CONTEXT,
  with: (ctx, fn, thisArg, ...args) => storage.run(ctx, () => fn.call(thisArg, ...args)),
  bind: (_ctx, target) => target,
  enable() {
    return this;
  },
  disable() {
    storage.disable();
    return this;
  },
};
const w3c = {
  fields: () => ['traceparent'],
  inject(ctx: Context, carrier: unknown, setter: TextMapSetter): void {
    const sc = trace.getSpanContext(ctx);
    if (sc !== undefined) setter.set(carrier, 'traceparent', `00-${sc.traceId}-${sc.spanId}-01`);
  },
  extract(ctx: Context, carrier: unknown, getter: TextMapGetter): Context {
    const raw = getter.get(carrier, 'traceparent');
    const [, traceId, spanId] = String(Array.isArray(raw) ? raw[0] : raw).split('-');
    if (traceId === undefined || spanId === undefined) return ctx;
    return trace.setSpanContext(ctx, { traceId, spanId, isRemote: true, traceFlags: TraceFlags.SAMPLED });
  },
};
const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
const META = 'langfuse.observation.metadata.';
const spans = (name: string) =>
  exporter
    .getFinishedSpans()
    .filter((s) => s.name === name)
    .map((s) => ({
      parent: s.parentSpanContext?.spanId,
      id: s.spanContext().spanId,
      zero: s.startTime[0] === s.endTime[0] && s.startTime[1] === s.endTime[1],
      meta: Object.fromEntries(
        Object.entries(s.attributes)
          .filter(([k]) => k.startsWith(META))
          .map(([k, v]) => [k.slice(META.length), String(v)]),
      ),
    }));

const AUTH_TOKEN = 'f'.repeat(32);
const CALL_SID = `CA${'3'.repeat(32)}`;
const dir = mkdtempSync(join(tmpdir(), 'cr-tuning-'));
const events: ObsEvent[] = [];
const bus = createObsBus();
bus.subscribe((e) => events.push(e));
const tuning = createCrTuning({ store: createProfileStore(dir), bus, insights: null });
const config = loadConfig({
  TWILIO_ACCOUNT_SID: `AC${'0'.repeat(32)}`,
  TWILIO_AUTH_TOKEN: AUTH_TOKEN,
  TWILIO_API_KEY: `SK${'0'.repeat(32)}`,
  TWILIO_API_SECRET: 'secret',
  TWILIO_PHONE_NUMBER: '+15550000000',
  TWILIO_VOICE_PUBLIC_DOMAIN: 'demo.example.com',
});
const { app } = buildApp({ config, caps: capabilities(config), tuning });
let handle: TacHandle;
let base = '';

/** A client socket with an inbox of parsed frames and a waiter for the next frame matching a predicate. */
async function relaySocket(url: string) {
  const ws = new WebSocket(url, {
    headers: { 'x-twilio-signature': twilio.getExpectedTwilioSignature(AUTH_TOKEN, url.replace(/^ws:/, 'wss:'), {}) },
  } as unknown as string[]);
  const inbox: Record<string, unknown>[] = [];
  const waiters: { match: (f: Record<string, unknown>) => boolean; resolve: (f: Record<string, unknown>) => void }[] = [];
  ws.onmessage = (e) => {
    const frame = JSON.parse(String(e.data)) as Record<string, unknown>;
    inbox.push(frame);
    for (const w of waiters.splice(0)) (w.match(frame) ? w.resolve(frame) : waiters.push(w));
  };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  return {
    send: (frame: object) => ws.send(JSON.stringify(frame)),
    next: (match: (f: Record<string, unknown>) => boolean) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const seen = inbox.find(match);
        if (seen !== undefined) {
          inbox.splice(inbox.indexOf(seen), 1);
          resolve(seen);
        } else waiters.push({ match, resolve });
      }),
    close: () => ws.close(),
  };
}

const getJson = async <T>(path: string): Promise<T> => (await fetch(`${base}${path}`)).json() as Promise<T>;
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const lastToken = (f: Record<string, unknown>) => f.type === 'text' && f.last === true;

beforeAll(async () => {
  setLangfuseTracerProvider(provider);
  context.setGlobalContextManager(contextManager);
  propagation.setGlobalPropagator(w3c);
  handle = await bootTac({
    app,
    config,
    caps: capabilities(config),
    turn: fakeTurnDeps(['Sure', ', one moment.'], 'Sure, one moment.', [], { deltaDelayMs: 2 }),
    tuning,
    port: 0,
  });
  await handle.start();
  const address = app.server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
});

afterAll(async () => {
  handle.shutdown();
  await app.close();
  setLangfuseTracerProvider(null);
  context.disable();
  await provider.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

test('inbound TwiML carries the saved profile and events="config-updated", and keeps actionUrl', async () => {
  const applied = (await (
    await fetch(`${base}${TUNING_APPLY_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: { ...TWILIO_DEFAULTS, speechTimeout: '1000', turnDetection: 'true', hints: 'Northwind' } }),
    })
  ).json()) as ApplyResponse;
  expect(applied.rev).toBe(2);
  expect(applied.calls).toEqual([]);
  expect(JSON.parse(readFileSync(join(dir, 'cr-profile.json'), 'utf8')).rev).toBe(2);

  const form = { CallSid: CALL_SID, From: '+15551112222', To: '+15550000000', AccountSid: config.twilio?.accountSid ?? '' };
  const twimlUrl = `https://${base.slice('http://'.length)}/twiml`;
  const res = await fetch(`${base}/twiml`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': twilio.getExpectedTwilioSignature(AUTH_TOKEN, twimlUrl, form),
    },
    body: new URLSearchParams(form).toString(),
  });
  const twiml = await res.text();
  expect(res.status).toBe(200);
  expect(twiml).toContain('<Connect action="https://demo.example.com/api/voice/relay-action">');
  expect(twiml).toContain('events="config-updated"');
  expect(twiml).toContain('speechTimeout="1000"');
  expect(twiml).toContain('turnDetection="true"');
  expect(twiml).toContain('hints="Northwind"');
  expect(twiml).toContain('reportInputDuringAgentSpeech="any"');
  expect(twiml).toContain('welcomeGreeting="Thanks for calling Northwind. How can I help?"');
});

test('apply reaches a live socket as one config frame, configUpdated marks it effective, and spans land under the root', async () => {
  const ws = await relaySocket(`${base.replace('http:', 'ws:')}/ws`);
  ws.send({
    type: 'setup',
    sessionId: 'VX1',
    callSid: CALL_SID,
    from: '+15551112222',
    to: '+15550000000',
    direction: 'inbound',
    callType: 'PSTN',
    callStatus: 'in-progress',
    accountSid: config.twilio?.accountSid,
  });
  ws.send({ type: 'info', name: 'configUpdated', value: { session: { interruptSensitivity: 'high', speechTimeout: '1000' } } });
  ws.send({ type: 'info', name: 'configUpdated', value: { language: [{ code: 'en-US', ttsProvider: 'elevenlabs', voice: 'UgBBYS2sOqTuMpoF3BR0' }] } });
  ws.send({ type: 'info', name: 'configUpdated', value: { language: [{ code: 'en-US', transcriptionProvider: 'deepgram', speechModel: 'nova-3-general' }] } });
  ws.send({ type: 'prompt', voicePrompt: 'where is my order', last: true });
  await ws.next(lastToken);
  await settle();

  const state = await getJson<TuningState>(TUNING_PATH);
  expect(state.liveCalls).toHaveLength(1);
  expect(state.liveCalls[0]?.startRev).toBe(2);
  expect(state.liveCalls[0]?.effective.ttsProvider).toBe('ElevenLabs');

  const applyRes = await fetch(`${base}${TUNING_APPLY_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profile: { ...state.profile, interruptSensitivity: 'medium', welcomeGreeting: 'Hi.' } }),
  });
  const applied = (await applyRes.json()) as ApplyResponse;
  expect(applied.rev).toBe(3);
  expect(applied.nextCall).toEqual(['welcomeGreeting']);
  expect(applied.calls).toEqual([
    { sid: CALL_SID, conversationId: CALL_SID, frame: { type: 'config', session: { interruptSensitivity: 'medium' } }, sent: true, error: null },
  ]);
  expect(await ws.next((f) => f.type === 'config')).toEqual({ type: 'config', session: { interruptSensitivity: 'medium' } });
  expect((await getJson<CallsResponse>(CALLS_PATH)).calls[0]?.applying).toBe(true);

  await settle(20);
  ws.send({ type: 'info', name: 'configUpdated', value: { session: { interruptSensitivity: 'medium' } } });
  ws.send({ type: 'error', description: 'Parameter foo is not allowed' });
  ws.send({ type: 'prompt', voicePrompt: 'thanks', last: true });
  await ws.next(lastToken);
  await settle();

  const timeline = await getJson<CallTimeline>(callTimelinePath(CALL_SID));
  expect(timeline.turns.map((t) => t.rev)).toEqual(['2', '3']);
  expect(timeline.insights).toBe('pending');
  const change = timeline.applies[0]?.changes[0];
  expect(change?.key).toBe('interruptSensitivity');
  expect(change?.effectiveAt).toBeGreaterThan(timeline.applies[0]?.at ?? Infinity);
  expect(change?.firstTurn).toBe(2);
  expect(timeline.applying).toBe(false);
  expect((await getJson<TuningState>(TUNING_PATH)).liveCalls[0]?.effective.interruptSensitivity).toBe('medium');

  ws.close();
  await settle(100);
  const calls = await getJson<CallsResponse>(CALLS_PATH);
  expect(calls.calls[0]).toMatchObject({ sid: CALL_SID, live: false });

  const [root] = spans('conversation.voice');
  expect(root).toBeDefined();
  const apply = spans('cr.config.apply');
  const updated = spans('cr.config.updated');
  const error = spans('cr.config.error');
  expect(apply).toHaveLength(1);
  expect(updated).toHaveLength(4);
  expect(error).toHaveLength(1);
  for (const s of [...apply, ...updated, ...error]) {
    expect(s.parent).toBe(root?.id);
    expect(s.zero).toBe(true);
  }
  expect(apply[0]?.meta).toMatchObject({ 'cr.config.revision': '3', 'cr.config.apply_id': applied.applyId });
  expect(JSON.parse(apply[0]?.meta['cr.config.frame'] ?? '')).toEqual({ type: 'config', session: { interruptSensitivity: 'medium' } });
  expect(updated.filter((s) => s.meta['cr.config.initial'] === 'true')).toHaveLength(3);
  const effect = updated.find((s) => s.meta['cr.config.initial'] === 'false');
  expect(effect?.meta['cr.config.apply_id']).toBe(applied.applyId);
  expect(Number(effect?.meta['cr.config.since_apply_ms'])).toBeGreaterThanOrEqual(20);
  expect(error[0]?.meta['cr.config.error']).toBe('Parameter foo is not allowed');
  expect(spans('turn.voice').map((s) => s.meta['cr.config.revision'])).toEqual(['2', '3']);

  expect(events.map((e) => e.kind).filter((k) => k.startsWith('cr.config.'))).toEqual([
    'cr.config.updated',
    'cr.config.updated',
    'cr.config.updated',
    'cr.config.apply',
    'cr.config.updated',
    'cr.config.error',
  ]);
});
