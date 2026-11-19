/** When a changed parameter takes effect on a live call, per the ConversationRelay dynamic-configuration reference. */
export type Timing = 'now' | 'turn-end' | 'next-reply' | 'next-call';

/** Which part of a `config` frame a parameter travels in, or `twiml` when it can only be set at call start. */
export type Slot = 'language' | 'session' | 'twiml';

export type Group = 'stt' | 'tts' | 'turn' | 'next-call';

/** Attribute values keyed by attribute name, as strings — the same encoding `configUpdated` reports. */
export type Profile = Readonly<Record<string, string>>;

/** One tunable ConversationRelay attribute. */
export interface Param {
  readonly key: string;
  readonly label: string;
  readonly group: Group;
  readonly timing: Timing;
  readonly slot: Slot;
  readonly kind: 'select' | 'segmented' | 'bool' | 'text';
  readonly wire: 'string' | 'number' | 'boolean';
  readonly common: boolean;
  readonly doc: string;
  readonly url: string;
  readonly options?: readonly string[];
  readonly optionsBy?: { readonly key: string; readonly map: Readonly<Record<string, readonly string[]>> };
  readonly disabledReason?: (v: Profile) => string | null;
  readonly locked?: boolean;
}

const NOUN = 'https://www.twilio.com/docs/voice/conversationrelay/conversationrelay-noun';
const VOICES = 'https://www.twilio.com/docs/voice/conversationrelay/voice-configuration';
export const DYNAMIC_CONFIG_URL = 'https://www.twilio.com/docs/voice/conversationrelay/dynamic-configuration';

export const GROUPS: readonly { readonly id: Group; readonly title: string }[] = [
  { id: 'turn', title: 'Turn-taking' },
  { id: 'stt', title: 'Speech-to-text' },
  { id: 'tts', title: 'Text-to-speech' },
  { id: 'next-call', title: 'Next call only' },
];

export const TIMING_ORDER: readonly Timing[] = ['turn-end', 'next-reply', 'now', 'next-call'];

export const TIMING_LABEL: Readonly<Record<Timing, string>> = {
  now: 'now',
  'turn-end': 'end of turn',
  'next-reply': 'next reply',
  'next-call': 'next call',
};

/** What each timing class means, per the dynamic-configuration reference. */
export const TIMING_HELP: Readonly<Record<Timing, string>> = {
  now: 'Applies as soon as Twilio validates the frame.',
  'turn-end': 'Applies when the caller’s current turn ends, or at once if the call is idle.',
  'next-reply': 'Applies to the next text sent. A change mid-reply splits the reply.',
  'next-call': 'Cannot change mid-call. Applies to the next call’s TwiML.',
};

const UNCONFIRMED = ' Not in the dynamic-config reference — confirm on the first call.';

export const PARAMS: readonly Param[] = [
  { key: 'transcriptionProvider', label: 'Provider', group: 'stt', timing: 'turn-end', slot: 'language', kind: 'segmented', wire: 'string', common: true, options: ['Deepgram', 'Google'], url: NOUN, doc: 'Speech-to-text vendor: Deepgram (default) or Google. Sent together with a speech model valid for the provider.' },
  {
    key: 'speechModel', label: 'Speech model', group: 'stt', timing: 'turn-end', slot: 'language', kind: 'select', wire: 'string', common: true, url: NOUN,
    optionsBy: { key: 'transcriptionProvider', map: { Deepgram: ['nova-3-general', 'nova-2-general', 'flux'], Google: ['telephony', 'long'] } },
    doc: 'STT model. Deepgram: nova-3-general (default for most languages), nova-2-general, or flux, which brings its own turn detection. Google: telephony (default).',
  },
  { key: 'hints', label: 'Hints', group: 'stt', timing: 'turn-end', slot: 'language', kind: 'text', wire: 'string', common: true, url: NOUN, doc: 'Words or phrases callers are likely to say, comma-separated, to bias recognition. Capitalize proper nouns. Empty clears.' },
  { key: 'profanityFilter', label: 'Profanity filter', group: 'stt', timing: 'turn-end', slot: 'session', kind: 'bool', wire: 'boolean', common: false, url: NOUN, doc: 'Masks profanity in transcripts, keeping only the first letter. On by default.' },
  {
    key: 'deepgramSmartFormat', label: 'Smart format', group: 'stt', timing: 'turn-end', slot: 'session', kind: 'bool', wire: 'boolean', common: false, url: NOUN,
    disabledReason: (v) => (v.transcriptionProvider === 'Deepgram' ? null : 'Deepgram only'),
    doc: `Deepgram rewrites dates, times, currency, numbers and addresses into their written forms. On by default.${UNCONFIRMED}`,
  },

  { key: 'ttsProvider', label: 'Provider', group: 'tts', timing: 'next-reply', slot: 'language', kind: 'segmented', wire: 'string', common: true, options: ['ElevenLabs', 'Google', 'Amazon'], url: NOUN, doc: 'Text-to-speech vendor: ElevenLabs (default), Google or Amazon. Sent together with a voice from the provider.' },
  {
    key: 'voice', label: 'Voice', group: 'tts', timing: 'next-reply', slot: 'language', kind: 'select', wire: 'string', common: true, url: VOICES,
    optionsBy: { key: 'ttsProvider', map: { ElevenLabs: ['UgBBYS2sOqTuMpoF3BR0', 'XrExE9yKIg1WjnnlVkGX'], Google: ['en-US-Chirp3-HD-Aoede', 'en-US-Chirp3-HD-Charon', 'en-US-Neural2-F'], Amazon: ['Joanna-Neural', 'Matthew-Neural'] } },
    doc: 'Voice ID for the chosen provider. An invalid provider/voice pair is rejected mid-call, and ends the session at call start.',
  },
  {
    key: 'elevenlabsModel', label: 'Model', group: 'tts', timing: 'next-reply', slot: 'language', kind: 'select', wire: 'string', common: true, url: VOICES, options: ['default', 'flash_v2_5', 'turbo_v2_5', 'v4'],
    disabledReason: (v) => (v.ttsProvider === 'ElevenLabs' ? null : 'ElevenLabs only'),
    doc: 'Model suffix on the ElevenLabs voice ID. With none, en-US uses Flash 2. v4 is what the docs recommend; v3 and v4 do not support a speed setting.',
  },
  {
    key: 'elevenlabsTextNormalization', label: 'Text normalization', group: 'tts', timing: 'next-reply', slot: 'language', kind: 'segmented', wire: 'string', common: false, options: ['off', 'on'], url: NOUN,
    disabledReason: (v) => (v.ttsProvider === 'ElevenLabs' ? null : 'ElevenLabs only'),
    doc: 'ElevenLabs normalizes numbers, dates and similar text before speaking. On adds a step and latency; off is the default.',
  },

  {
    key: 'turnDetection', label: 'Smart turn detection', group: 'turn', timing: 'turn-end', slot: 'session', kind: 'bool', wire: 'boolean', common: true, url: NOUN,
    disabledReason: (v) => (v.speechModel === 'flux' ? 'bypassed under flux' : null),
    doc: `Twilio’s semantics-aware model decides when the caller has finished, instead of a silence timer. Bypassed when the speech model is flux.${UNCONFIRMED}`,
  },
  {
    key: 'eotThreshold', label: 'End-of-turn threshold', group: 'turn', timing: 'turn-end', slot: 'session', kind: 'select', wire: 'number', common: true, url: NOUN,
    options: ['0.5', '0.55', '0.6', '0.65', '0.7', '0.75', '0.8', '0.85', '0.9'],
    disabledReason: (v) => (v.speechModel === 'flux' || v.turnDetection === 'true' ? null : 'needs flux or smart turn detection'),
    doc: 'Confidence needed to end a turn, 0.5–0.9, default 0.8. Lower ends turns sooner.',
  },
  { key: 'speechTimeout', label: 'Speech timeout', group: 'turn', timing: 'turn-end', slot: 'session', kind: 'select', wire: 'number', common: true, url: NOUN, options: ['auto', '600', '800', '1000', '1500', '2000', '3000', '5000'], doc: 'How long to wait after speech ends before sending the final prompt: auto, or 600–5000 ms. Starts only once the caller speaks.' },
  { key: 'interruptSensitivity', label: 'Interrupt sensitivity', group: 'turn', timing: 'turn-end', slot: 'session', kind: 'segmented', wire: 'string', common: true, options: ['low', 'medium', 'high'], url: NOUN, doc: 'How easily caller speech interrupts. High (default) triggers most easily; low needs longer, more confident speech.' },
  { key: 'ignoreBackchannel', label: 'Ignore backchannel', group: 'turn', timing: 'turn-end', slot: 'session', kind: 'bool', wire: 'boolean', common: true, url: NOUN, doc: 'Filters short feedback such as “yeah” or “uh-huh” so it does not interrupt the agent.' },
  { key: 'echoPromptFiltering', label: 'Echo prompt filtering', group: 'turn', timing: 'turn-end', slot: 'session', kind: 'bool', wire: 'boolean', common: true, url: NOUN, doc: 'Removes transcript words that match the agent’s own speech, using TTS word timings, so the agent does not interrupt itself.' },
  { key: 'dtmfDetection', label: 'DTMF detection', group: 'turn', timing: 'turn-end', slot: 'session', kind: 'bool', wire: 'boolean', common: false, url: NOUN, doc: 'Sends caller keypresses to your app over the WebSocket.' },
  { key: 'interruptible', label: 'Interruptible by', group: 'turn', timing: 'now', slot: 'session', kind: 'segmented', wire: 'string', common: true, options: ['none', 'dtmf', 'speech', 'any'], url: NOUN, doc: 'Which caller input stops the agent’s playback. Applies to replies that start after the update.' },
  { key: 'preemptible', label: 'Preemptible', group: 'turn', timing: 'now', slot: 'session', kind: 'bool', wire: 'boolean', common: false, url: NOUN, doc: 'Lets text from the next talk cycle interrupt speech that is still playing.' },
  { key: 'reportInputDuringAgentSpeech', label: 'Report input during speech', group: 'turn', timing: 'now', slot: 'session', kind: 'segmented', wire: 'string', common: false, options: ['none', 'dtmf', 'speech', 'any'], url: NOUN, doc: 'Whether your app receives caller input while the agent is talking. Twilio’s default is none; this repo pins any so barge-in words reach the agent.' },
  { key: 'partialPrompts', label: 'Partial prompts', group: 'turn', timing: 'now', slot: 'session', kind: 'bool', wire: 'boolean', common: false, url: NOUN, doc: 'Sends unfinalized prompts and eager end-of-turn events, marked last=false.' },

  { key: 'welcomeGreeting', label: 'Welcome greeting', group: 'next-call', timing: 'next-call', slot: 'twiml', kind: 'text', wire: 'string', common: true, url: NOUN, doc: 'Spoken when the call connects. Fixed for the session.' },
  { key: 'welcomeGreetingInterruptible', label: 'Greeting interruptible by', group: 'next-call', timing: 'next-call', slot: 'twiml', kind: 'segmented', wire: 'string', common: true, options: ['none', 'dtmf', 'speech', 'any'], url: NOUN, doc: 'Which caller input can cut off the welcome greeting.' },
  { key: 'partialPromptOnHangup', label: 'Partial prompt on hangup', group: 'next-call', timing: 'next-call', slot: 'twiml', kind: 'bool', wire: 'boolean', common: true, url: NOUN, doc: 'Sends a pending unfinalized prompt when the call ends; off discards it.' },
  { key: 'events', label: 'Events', group: 'next-call', timing: 'next-call', slot: 'twiml', kind: 'text', wire: 'string', common: true, locked: true, url: NOUN, doc: 'Event subscriptions. config-updated makes Twilio report each change when it takes effect. It cannot be added mid-call, so it is always on.' },
];

/** Twilio's documented defaults, plus this repo's pinned `reportInputDuringAgentSpeech` and the always-on `events`. */
export const TWILIO_DEFAULTS: Profile = {
  transcriptionProvider: 'Deepgram',
  speechModel: 'nova-3-general',
  hints: '',
  profanityFilter: 'true',
  deepgramSmartFormat: 'true',
  ttsProvider: 'ElevenLabs',
  voice: 'UgBBYS2sOqTuMpoF3BR0',
  elevenlabsModel: 'default',
  elevenlabsTextNormalization: 'off',
  turnDetection: 'false',
  eotThreshold: '0.8',
  speechTimeout: 'auto',
  interruptible: 'any',
  interruptSensitivity: 'high',
  ignoreBackchannel: 'false',
  echoPromptFiltering: 'false',
  preemptible: 'false',
  reportInputDuringAgentSpeech: 'any',
  partialPrompts: 'false',
  dtmfDetection: 'false',
  welcomeGreeting: 'Thanks for calling Northwind. How can I help?',
  welcomeGreetingInterruptible: 'any',
  partialPromptOnHangup: 'true',
  events: 'config-updated',
};

/** A named overlay: loading it stages only the keys it defines. */
export interface Preset {
  readonly name: string;
  readonly values: Profile;
}

export const PRESETS: readonly Preset[] = [
  { name: 'Twilio defaults', values: TWILIO_DEFAULTS },
  { name: 'Fast turns — Deepgram flux', values: { transcriptionProvider: 'Deepgram', speechModel: 'flux', eotThreshold: '0.7', ignoreBackchannel: 'true' } },
  { name: 'Smart turn detection', values: { transcriptionProvider: 'Deepgram', speechModel: 'nova-3-general', turnDetection: 'true', interruptSensitivity: 'medium' } },
  { name: 'Expressive — ElevenLabs v4', values: { ttsProvider: 'ElevenLabs', elevenlabsModel: 'v4', echoPromptFiltering: 'true' } },
  { name: 'Google Chirp 3 HD', values: { ttsProvider: 'Google', voice: 'en-US-Chirp3-HD-Charon' } },
];


/** A value as ConversationRelay receives it on the wire. */
export type WireValue = string | number | boolean;

/** The `config` WebSocket frame that changes a live ConversationRelay session. */
export interface ConfigFrame {
  readonly type: 'config';
  readonly language?: Readonly<Record<string, WireValue>>;
  readonly session?: Readonly<Record<string, WireValue>>;
}

/** Returns the catalog entry for `key`. Throws if `key` is not in `PARAMS`. */
export function param(key: string): Param {
  const p = PARAMS.find((x) => x.key === key);
  if (p === undefined) throw new Error(`unknown ConversationRelay parameter: ${key}`);
  return p;
}

/** Returns the options `p` offers under profile `v`, resolving `optionsBy` against the key it depends on. */
export const optionsFor = (p: Param, v: Profile): readonly string[] =>
  p.optionsBy ? (p.optionsBy.map[v[p.optionsBy.key] ?? ''] ?? []) : (p.options ?? []);

/** Returns the keys in `PARAMS` order whose value in `staged` differs from `applied`. */
export const diffKeys = (applied: Profile, staged: Profile): string[] =>
  PARAMS.filter((p) => applied[p.key] !== staged[p.key]).map((p) => p.key);

/** Returns the voice string ConversationRelay receives: the voice ID plus the ElevenLabs model suffix, if any. */
export const wireVoice = (v: Profile): string =>
  v.ttsProvider === 'ElevenLabs' && v.elevenlabsModel && v.elevenlabsModel !== 'default'
    ? `${v.voice}-${v.elevenlabsModel}`
    : (v.voice ?? '');

/** Converts a profile string to its wire type per `p.wire`; `'auto'` stays a string for numeric params. */
export const toWire = (p: Param, raw: string): WireValue =>
  p.wire === 'boolean' ? raw === 'true' : p.wire === 'number' && raw !== 'auto' ? Number(raw) : raw;

/** True when `key` can change mid-call under profile `v`: not `next-call`, and not disabled. */
export const isLiveKey = (key: string, v: Profile): boolean => {
  const p = param(key);
  return p.timing !== 'next-call' && !p.disabledReason?.(v);
};

/**
 * Builds the `config` frame for the live-applicable part of a diff.
 *
 * @param keys - Changed keys, typically from `diffKeys`. `next-call` keys, and keys whose `disabledReason`
 *   is non-null under `v`, are ignored.
 * @param v - The profile the values are read from.
 * @returns The frame, with `ttsProvider`/`voice` and `transcriptionProvider`/`speechModel` always sent as
 *   pairs and `elevenlabsModel` folded into `voice`; or `null` when no key can change mid-call.
 */
export function configFrame(keys: readonly string[], v: Profile): ConfigFrame | null {
  const live = new Set(keys.filter((k) => isLiveKey(k, v)));
  if (live.has('ttsProvider') || live.has('elevenlabsModel')) live.add('voice');
  if (live.has('voice')) live.add('ttsProvider');
  if (live.has('transcriptionProvider')) live.add('speechModel');
  if (live.has('speechModel')) live.add('transcriptionProvider');
  live.delete('elevenlabsModel');
  if (live.size === 0) return null;
  const language: Record<string, WireValue> = {};
  const session: Record<string, WireValue> = {};
  for (const key of live) {
    const p = param(key);
    (p.slot === 'language' ? language : session)[key] = key === 'voice' ? wireVoice(v) : toWire(p, v[key] ?? '');
  }
  return {
    type: 'config',
    ...(Object.keys(language).length ? { language } : {}),
    ...(Object.keys(session).length ? { session } : {}),
  };
}

/** Attributes `relayAttributes` emits whatever their value. */
const ALWAYS_EMITTED: ReadonlySet<string> = new Set(['welcomeGreeting', 'events']);

/**
 * Maps a profile to the `<ConversationRelay>` attributes the next call should carry.
 *
 * @param v - The profile.
 * @returns Wire-typed attributes keyed by attribute name: `welcomeGreeting` and `events` always; every
 *   other parameter only when it differs from `TWILIO_DEFAULTS` and its `disabledReason` is null under `v`.
 *   `elevenlabsModel` is folded into `voice`, and a provider is emitted whenever its paired voice or speech
 *   model is. `actionUrl` and the WebSocket URL are not included.
 */
export function relayAttributes(v: Profile): Record<string, WireValue> {
  const out: Record<string, WireValue> = {};
  for (const p of PARAMS) {
    if (p.key === 'elevenlabsModel') continue;
    if (p.disabledReason?.(v)) continue;
    const value = p.key === 'voice' ? wireVoice(v) : (v[p.key] ?? '');
    const fallback = p.key === 'voice' ? (TWILIO_DEFAULTS.voice ?? '') : (TWILIO_DEFAULTS[p.key] ?? '');
    if (ALWAYS_EMITTED.has(p.key) || value !== fallback) out[p.key] = p.key === 'voice' ? value : toWire(p, value);
  }
  if ('voice' in out) out.ttsProvider = v.ttsProvider ?? '';
  if ('speechModel' in out) out.transcriptionProvider = v.transcriptionProvider ?? '';
  return out;
}
