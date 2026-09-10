import { test, expect } from 'vitest';
import {
  PRODUCTION_LABEL,
  PROMPT_CACHE_TTL_DEV_MS,
  PROMPT_CACHE_TTL_PROD_MS,
  PromptConfigSchema,
  promptCacheTtlMs,
} from '../server/agent/prompt/port.ts';
import {
  CHANNEL_PROMPT,
  DEFAULT_PROMPTS,
  PROMPT_NAMES,
  fallbackPrompt,
} from '../server/agent/prompt/defaults.ts';
import { SLOT_NAMES, compose } from '../server/agent/prompt/slots.ts';
import {
  createLangfusePromptPort,
  type FetchedPrompt,
  type LangfusePromptDeps,
  type PromptFetcher,
  type PromptLogger,
} from '../server/agent/prompt/langfuse.ts';
import { createObsBus } from '../server/obs/bus.ts';
import { OBS_CHANNELS, type ObsEvent } from '../shared/events.ts';

// ------------------------------------------------------------------ the config schema

test('an unknown config key is rejected rather than stripped', () => {
  // The reason `.strict()` is there: `max_steps` in the Langfuse form must surface as a failure,
  // not silently leave the agent on maxSteps 4 while the operator believes they set 8.
  const parsed = PromptConfigSchema.safeParse({ model: 'gpt-5.4-mini', max_steps: 8 });
  expect(parsed.success).toBe(false);
});

test('an empty config parses to the documented defaults', () => {
  const parsed = PromptConfigSchema.parse({});
  expect(parsed).toEqual({
    model: 'gpt-5.4-mini',
    tools: [],
    toolChoice: 'auto',
    maxSteps: 4,
  });
});

test('out-of-range values fail', () => {
  expect(PromptConfigSchema.safeParse({ maxSteps: 9 }).success).toBe(false);
  expect(PromptConfigSchema.safeParse({ temperature: 2.1 }).success).toBe(false);
  // The edges themselves are legal, or the bounds would be off by one.
  expect(PromptConfigSchema.safeParse({ maxSteps: 8, temperature: 2 }).success).toBe(true);
});

test('tools are names, so a schema smuggled into the config is rejected', () => {
  expect(
    PromptConfigSchema.safeParse({ tools: [{ name: 'search_knowledge', parameters: {} }] }).success,
  ).toBe(false);
});

// ------------------------------------------------------------------ the compiled defaults

test('every compiled default carries a config that parses clean', () => {
  for (const name of PROMPT_NAMES) {
    const parsed = PromptConfigSchema.safeParse(DEFAULT_PROMPTS[name].config);
    expect(parsed.success, `${name}: ${parsed.error?.message}`).toBe(true);
  }
});

test('every compiled default enables at least one tool and has a system message', () => {
  for (const name of PROMPT_NAMES) {
    const { messages, config } = DEFAULT_PROMPTS[name];
    expect(config.tools.length, `${name} has no tools`).toBeGreaterThan(0);
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content.length).toBeGreaterThan(200);
  }
});

test('every placeholder in the compiled defaults is an allowlisted slot', () => {
  // Catches at test time the exact bug slots.ts renders loudly at runtime: a misspelt slot in the
  // prompt text, which otherwise produces a quietly worse agent that passes everything else.
  for (const name of PROMPT_NAMES) {
    for (const message of DEFAULT_PROMPTS[name].messages) {
      for (const [, slot] of message.content.matchAll(/\{\{\s*([^{}\s]+)\s*\}\}/g)) {
        expect(SLOT_NAMES, `${name} references {{${slot}}}`).toContain(slot);
      }
    }
  }
});

test('both defaults customise through slots rather than prose', () => {
  // The premise of the compiled defaults: a cloner changes the persona and the company by setting
  // two slot values, not by rewriting the prompt. A prose edit that hard-codes either breaks that.
  for (const name of PROMPT_NAMES) {
    const text = DEFAULT_PROMPTS[name].messages.map((m) => m.content).join('\n');
    expect(text, `${name} lost {{persona}}`).toContain('{{persona}}');
    expect(text, `${name} lost {{company_name}}`).toContain('{{company_name}}');
  }
});

test('every channel maps to a prompt that actually exists', () => {
  for (const channel of OBS_CHANNELS) {
    expect(PROMPT_NAMES).toContain(CHANNEL_PROMPT[channel]);
  }
  // The bench exists to exercise the same path SMS takes, so it must share SMS's prompt.
  expect(CHANNEL_PROMPT.bench).toBe(CHANNEL_PROMPT.sms);
});

test('fallbackPrompt reports the degraded state on its face', () => {
  const p = fallbackPrompt('demo-agent-voice');
  expect(p.version).toBe('fallback');
  expect(p.label).toBeNull();
  expect(p.telemetryLink).toBeNull();
  expect(p.messages).toEqual(DEFAULT_PROMPTS['demo-agent-voice'].messages);
});

test('an unrecognised prompt name still yields a usable prompt', () => {
  // get() promises never to reject, and a channel with no prompt at all is dead air.
  const p = fallbackPrompt('demo-agent-typo');
  expect(p.name).toBe('demo-agent-typo'); // what was asked for, so the console can report it
  expect(p.messages).toEqual(DEFAULT_PROMPTS['demo-agent-text'].messages);
});

// ------------------------------------------------------------------ slots

test('a known slot substitutes, every occurrence of it', () => {
  const [message] = compose(
    [{ role: 'system', content: 'You are {{persona}}. Remember: {{persona}}.' }],
    { persona: 'a calm support agent' },
  );
  expect(message?.content).toBe('You are a calm support agent. Remember: a calm support agent.');
});

test('an unknown slot renders visibly instead of throwing or persisting', () => {
  const [message] = compose([{ role: 'system', content: 'Hello {{compnay_name}}.' }], {
    company_name: 'Northwind Traders',
  });
  expect(message?.content).toBe('Hello [[UNKNOWN SLOT: compnay_name]].');
});

test('an allowlisted slot the caller forgot renders as a distinguishable marker', () => {
  const [message] = compose([{ role: 'system', content: 'You are {{persona}}.' }], {});
  expect(message?.content).toBe('You are [[MISSING SLOT: persona]].');
});

test('all four slots substitute, and surrounding whitespace is tolerated', () => {
  const [message] = compose(
    [{ role: 'user', content: '{{persona}}|{{ company_name }}|{{channel}}|{{current_date}}' }],
    {
      persona: 'a support agent',
      company_name: 'Northwind Traders',
      channel: 'voice',
      current_date: '10 September 2026',
    },
  );
  expect(message?.content).toBe('a support agent|Northwind Traders|voice|10 September 2026');
});

test('a slot value containing a regex replacement pattern is inserted literally', () => {
  const [message] = compose([{ role: 'system', content: '<{{persona}}>' }], { persona: '$& $1 $$' });
  expect(message?.content).toBe('<$& $1 $$>');
});

test('compose returns new messages and leaves the input untouched', () => {
  const original = [{ role: 'system' as const, content: 'You are {{persona}}.' }];
  const composed = compose(original, { persona: 'a support agent' });
  expect(original[0]?.content).toBe('You are {{persona}}.');
  expect(composed).not.toBe(original);
});

// ------------------------------------------------------------------ the Langfuse port

/** Injected instead of mocked: if it needs vi.mock, the seam is wrong. */
const fetched = (over: Partial<FetchedPrompt> = {}): FetchedPrompt => ({
  version: 7,
  labels: [PRODUCTION_LABEL],
  prompt: [{ role: 'system', content: 'Live prompt for {{company_name}}.' }],
  config: { model: 'gpt-5.4-mini', tools: ['search_knowledge'], toolChoice: 'auto', maxSteps: 2 },
  toJSON: () => '{"name":"demo-agent-voice","version":7}',
  ...over,
});

interface Warning {
  readonly msg: string;
  readonly reason: unknown;
}

const collectingLogger = (): PromptLogger & { readonly warnings: Warning[] } => {
  const warnings: Warning[] = [];
  return { warnings, warn: (fields, msg) => void warnings.push({ msg, reason: fields.reason }) };
};

const silent: PromptLogger = { warn: () => {} };

/** `langfuse: null` throughout: an injected fetcher replaces the client, so no credentials exist. */
const portWith = (
  extra: Omit<LangfusePromptDeps, 'langfuse'> = {},
): { port: ReturnType<typeof createLangfusePromptPort>; events: ObsEvent[] } => {
  const bus = createObsBus();
  const events: ObsEvent[] = [];
  bus.subscribe((e) => void events.push(e));
  return { port: createLangfusePromptPort({ langfuse: null, logger: silent, bus, ...extra }), events };
};

test('a live prompt is served with its version, label and telemetry link', async () => {
  const { port } = portWith({ fetcher: async () => fetched() });
  const p = await port.get('demo-agent-voice');

  expect(p.version).toBe(7);
  expect(p.label).toBe(PRODUCTION_LABEL);
  expect(p.telemetryLink).toBe('{"name":"demo-agent-voice","version":7}');
  expect(p.config.maxSteps).toBe(2);
  // Placeholders survive the fetch — substitution is slots.ts's job, not the port's.
  expect(p.messages).toEqual([{ role: 'system', content: 'Live prompt for {{company_name}}.' }]);
});

test('the port fetches by label, never by version', async () => {
  const seen: string[] = [];
  const { port } = portWith({
    fetcher: async (_name, label) => {
      seen.push(label);
      return fetched();
    },
  });
  await port.get('demo-agent-voice');
  // Fetching by label is the entire rollback mechanism: the operator moves the pointer.
  expect(seen).toEqual([PRODUCTION_LABEL]);
});

test('a live prompt with no config at all gets the schema defaults', async () => {
  const { port } = portWith({ fetcher: async () => fetched({ config: null }) });
  const p = await port.get('demo-agent-voice');
  expect(p.version).toBe(7); // not a fallback — an absent config is legitimate
  expect(p.config).toEqual({ model: 'gpt-5.4-mini', tools: [], toolChoice: 'auto', maxSteps: 4 });
});

test('a fetcher that throws yields the compiled default and does not reject', async () => {
  const logger = collectingLogger();
  const { port } = portWith({
    logger,
    fetcher: async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:3100');
    },
  });

  const p = await port.get('demo-agent-voice');
  expect(p.version).toBe('fallback');
  expect(p.telemetryLink).toBeNull();
  expect(p.messages).toEqual(DEFAULT_PROMPTS['demo-agent-voice'].messages);
  // One warning, naming both the prompt and the cause. Asserted rather than the exact wording,
  // which has no consumer.
  expect(logger.warnings).toHaveLength(1);
  expect(logger.warnings[0]?.reason).toBe('fetch_failed');
  expect(logger.warnings[0]?.msg).toContain('demo-agent-voice');
});

test('a malformed Langfuse config falls back rather than taking the agent down', async () => {
  const logger = collectingLogger();
  const { port } = portWith({
    logger,
    fetcher: async () => fetched({ config: { model: 'gpt-5.4-mini', max_steps: 8 } }),
  });

  const p = await port.get('demo-agent-voice');
  expect(p.version).toBe('fallback');
  expect(p.config).toEqual(DEFAULT_PROMPTS['demo-agent-voice'].config);
  expect(logger.warnings[0]?.reason).toBe('invalid_config');
});

test('messages Langfuse cannot supply as chat turns fall back too', async () => {
  const logger = collectingLogger();
  const { port } = portWith({
    logger,
    // What a chat prompt containing an unresolved placeholder entry looks like.
    fetcher: async () => fetched({ prompt: [{ type: 'placeholder', name: 'examples' }] }),
  });

  const p = await port.get('demo-agent-voice');
  expect(p.version).toBe('fallback');
  expect(logger.warnings[0]?.reason).toBe('invalid_messages');
});

test('no Langfuse configured is the same degraded path, named differently', async () => {
  const logger = collectingLogger();
  const port = createLangfusePromptPort({ langfuse: null, logger, bus: createObsBus() });

  const p = await port.get('demo-agent-text');
  expect(p.version).toBe('fallback');
  expect(logger.warnings[0]?.reason).toBe('not_configured');
});

test('two gets inside the TTL hit the fetcher once; the third, after it, refetches', async () => {
  let clock = 0;
  let calls = 0;
  const fetcher: PromptFetcher = async () => {
    calls++;
    return fetched();
  };
  const { port } = portWith({ fetcher, ttlMs: 1_000, now: () => clock });

  await port.get('demo-agent-voice');
  await port.get('demo-agent-voice');
  expect(calls).toBe(1);

  clock = 1_000;
  await port.get('demo-agent-voice');
  expect(calls).toBe(2);
});

test('the cache is per prompt name', async () => {
  const asked: string[] = [];
  const { port } = portWith({
    fetcher: async (name) => {
      asked.push(name);
      return fetched();
    },
  });
  await port.get('demo-agent-voice');
  await port.get('demo-agent-text');
  expect(asked).toEqual(['demo-agent-voice', 'demo-agent-text']);
});

test('a fallback is cached, so a down Langfuse is not re-asked on every turn', async () => {
  // FETCH_TIMEOUT_MS of silence once per TTL window is survivable; once per turn is not.
  let calls = 0;
  const { port } = portWith({
    ttlMs: 1_000,
    now: () => 0,
    fetcher: async () => {
      calls++;
      throw new Error('down');
    },
  });
  await port.get('demo-agent-voice');
  await port.get('demo-agent-voice');
  expect(calls).toBe(1);
});

test('every get publishes a prompt.fetch event carrying name, version and duration', async () => {
  const { port, events } = portWith({ fetcher: async () => fetched(), now: () => 0 });
  await port.get('demo-agent-voice');
  await port.get('demo-agent-voice');

  expect(events.map((e) => e.kind)).toEqual(['prompt.fetch', 'prompt.fetch']);
  expect(events[0]?.summary).toBe('demo-agent-voice v7');
  expect(events[0]?.payload).toEqual({
    name: 'demo-agent-voice',
    version: 7,
    label: PRODUCTION_LABEL,
    cached: false,
  });
  expect(events[0]?.durationMs).toBe(0);
  // The cache hit is still reported: ~0 ms next to a round-trip is the number worth seeing.
  expect(events[1]?.summary).toBe('demo-agent-voice v7 (cached)');
  expect(events[1]?.payload).toMatchObject({ cached: true });
});

test('a fallback event names its cause, so the console shows why', async () => {
  const { port, events } = portWith({
    fetcher: async () => {
      throw new Error('down');
    },
  });
  await port.get('demo-agent-voice');
  expect(events[0]?.summary).toBe('demo-agent-voice fallback — fetch_failed');
  expect(events[0]?.payload).toMatchObject({ version: 'fallback', reason: 'fetch_failed' });
});

// ------------------------------------------------------------------ cache TTL policy

test('the cache TTL is shorter outside production', () => {
  expect(promptCacheTtlMs('development')).toBe(PROMPT_CACHE_TTL_DEV_MS);
  expect(promptCacheTtlMs(undefined)).toBe(PROMPT_CACHE_TTL_DEV_MS);
  expect(promptCacheTtlMs('production')).toBe(PROMPT_CACHE_TTL_PROD_MS);
  expect(PROMPT_CACHE_TTL_DEV_MS).toBeLessThan(PROMPT_CACHE_TTL_PROD_MS);
});
