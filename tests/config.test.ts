import { test, expect } from 'vitest';
import { loadConfig, capabilities, unavailable, type Env } from '../server/config.ts';

/**
 * The contract under test is "never throws, always explains". Every case below is a
 * half-configured environment, because that is the state a demo is actually in most of the
 * time — and the state where a crash costs the most.
 */

const VALID: Env = {
  TWILIO_ACCOUNT_SID: 'AC' + '0'.repeat(32),
  TWILIO_AUTH_TOKEN: 'x'.repeat(32),
  TWILIO_API_KEY: 'SK' + '0'.repeat(32),
  TWILIO_API_SECRET: 'y'.repeat(32),
  TWILIO_PHONE_NUMBER: '+15551234567',
  TWILIO_VOICE_PUBLIC_DOMAIN: 'scaffold.twilio.dtolb.com',
  TWILIO_CONVERSATION_CONFIGURATION_ID: 'conv_configuration_abc',
  TWILIO_STUDIO_HANDOFF_FLOW_SID: 'FW' + '0'.repeat(32),
  OPENAI_API_KEY: 'sk-proj-test',
  LANGFUSE_BASE_URL: 'http://localhost:3100',
  LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
  LANGFUSE_SECRET_KEY: 'sk-lf-test',
  APP_NAME: 'my-demo',
};

test('an entirely empty environment does not throw', () => {
  expect(() => loadConfig({})).not.toThrow();
});

test('an empty environment reports every capability as unavailable, with reasons', () => {
  const c = loadConfig({});
  const caps = capabilities(c);
  expect(caps).toEqual({
    llm: false,
    prompts: false,
    voice: false,
    sms: false,
    memory: false,
    handoff: false,
    knowledge: false,
  });
  // Each missing entry must name a variable AND say what it breaks — a bare list of names
  // is not actionable in front of a customer.
  expect(c.missing.length).toBeGreaterThan(0);
  for (const m of c.missing) {
    expect(m.name).toBeTruthy();
    expect(m.breaks.length).toBeGreaterThan(10);
  }
});

test('a fully valid environment enables everything except knowledge', () => {
  const c = loadConfig(VALID);
  // Nothing is reported missing: TWILIO_KNOWLEDGE_BASE_ID is optional by design, so its
  // absence disables the knowledge tool without being a complaint.
  expect(c.missing).toEqual([]);
  expect(capabilities(c)).toEqual({
    llm: true,
    prompts: true,
    voice: true,
    sms: true,
    memory: true,
    handoff: true,
    knowledge: false, // no TWILIO_KNOWLEDGE_BASE_ID, and that is optional by design
  });
});

test('twilio is null unless ALL five core variables are well-formed', () => {
  // TACConfig.fromEnv() throws on any one of them, so this null is the guard that stops us
  // ever calling it.
  const partial = { ...VALID };
  delete partial.TWILIO_API_SECRET;
  expect(loadConfig(partial).twilio).toBeNull();
});

test('a malformed account SID is caught rather than passed to Twilio', () => {
  const c = loadConfig({ ...VALID, TWILIO_ACCOUNT_SID: 'not-a-sid' });
  expect(c.twilio).toBeNull();
  expect(c.missing.some((m) => m.name === 'TWILIO_ACCOUNT_SID')).toBe(true);
});

test('a non-E.164 phone number is rejected with a usable message', () => {
  const c = loadConfig({ ...VALID, TWILIO_PHONE_NUMBER: '555-1234' });
  expect(c.twilio).toBeNull();
  const issue = c.missing.find((m) => m.name === 'TWILIO_PHONE_NUMBER');
  expect(issue?.breaks).toContain('E.164');
});

test('a scheme on the voice domain is rejected — TAC wants the bare host', () => {
  const c = loadConfig({ ...VALID, TWILIO_VOICE_PUBLIC_DOMAIN: 'https://scaffold.twilio.dtolb.com' });
  expect(c.voice).toBeNull();
  expect(capabilities(c).voice).toBe(false);
  expect(c.missing.find((m) => m.name === 'TWILIO_VOICE_PUBLIC_DOMAIN')?.breaks).toContain('throws');
});

test('a port and a base path on the voice domain are both accepted', () => {
  // Both are documented as legal by TAC; rejecting them would break ngrok and sub-path setups.
  expect(loadConfig({ ...VALID, TWILIO_VOICE_PUBLIC_DOMAIN: 'x.ngrok.app:8080' }).voice).not.toBeNull();
  expect(loadConfig({ ...VALID, TWILIO_VOICE_PUBLIC_DOMAIN: 'example.com/server1' }).voice).not.toBeNull();
});

test('losing the CO id disables SMS, memory and handoff but leaves voice alone', () => {
  const partial = { ...VALID };
  delete partial.TWILIO_CONVERSATION_CONFIGURATION_ID;
  const caps = capabilities(loadConfig(partial));
  expect(caps.voice).toBe(true);
  expect(caps.sms).toBe(false);
  expect(caps.memory).toBe(false);
  expect(caps.handoff).toBe(false);
});

test('the missing-CO warning explains that SMSChannel throws', () => {
  const partial = { ...VALID };
  delete partial.TWILIO_CONVERSATION_CONFIGURATION_ID;
  const m = loadConfig(partial).missing.find(
    (x) => x.name === 'TWILIO_CONVERSATION_CONFIGURATION_ID',
  );
  expect(m?.breaks).toContain('THROWS');
});

test('the OPENAI_API_KEY warning calls out the easy misnaming', () => {
  // A 164-char key sitting in .env under the wrong name is a genuinely confusing failure.
  const partial = { ...VALID };
  delete partial.OPENAI_API_KEY;
  const m = loadConfig({ ...partial, OPENAI_APIKEY: 'sk-proj-oops' }).missing.find(
    (x) => x.name === 'OPENAI_API_KEY',
  );
  expect(m?.breaks).toContain('OPENAI_APIKEY');
});

test('losing Langfuse degrades prompts to fallback rather than failing', () => {
  const partial = { ...VALID };
  delete partial.LANGFUSE_SECRET_KEY;
  const c = loadConfig(partial);
  expect(c.langfuse).toBeNull();
  expect(capabilities(c).prompts).toBe(false);
  expect(c.missing.find((m) => m.feature === 'prompts + telemetry')?.breaks).toContain('fallback');
});

test('whitespace-only values count as absent', () => {
  expect(loadConfig({ ...VALID, OPENAI_API_KEY: '   ' }).openai).toBeNull();
});

test('appName defaults to scaffold so preflight can refuse it', () => {
  // Traefik router names are global on the box; two clones both called `scaffold` fight, and
  // one demo silently steals the other's webhooks.
  expect(loadConfig({}).appName).toBe('scaffold');
  expect(loadConfig(VALID).appName).toBe('my-demo');
});

test('unavailable() names the offending variables for the 503 body', () => {
  const c = loadConfig({});
  const body = unavailable(c, 'agent');
  expect(body.error).toBe('not_configured');
  expect(body.missing.map((m) => m.name)).toContain('OPENAI_API_KEY');
});
