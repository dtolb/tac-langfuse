import { test, expect } from 'vitest';
import Fastify from 'fastify';
import { capabilities, loadConfig } from '../server/config.ts';
import { registerHandoffRoutes } from '../server/http/routes-handoff.ts';
import { mintVoiceToken } from '../server/twilio/voice-token.ts';
import { CLIENT_IDENTITY, VOICE_TOKEN_PATH } from '../shared/handoff.ts';
import type { App } from '../server/http/types.ts';

const ACCOUNT_SID = 'AC' + 'a'.repeat(32);
const API_KEY = 'SK' + 'c'.repeat(32);

const fullEnv = {
  TWILIO_ACCOUNT_SID: ACCOUNT_SID,
  TWILIO_AUTH_TOKEN: 'token',
  TWILIO_API_KEY: API_KEY,
  TWILIO_API_SECRET: 'secret',
  TWILIO_PHONE_NUMBER: '+15550001111',
  TWILIO_VOICE_PUBLIC_DOMAIN: 'demo.test',
};

test('the minted token is a JWT granting incoming voice to our identity', () => {
  const jwt = mintVoiceToken({
    accountSid: ACCOUNT_SID,
    apiKey: API_KEY,
    apiSecret: 'secret',
    identity: CLIENT_IDENTITY,
  });

  const [header, claims] = jwt.split('.');
  expect(JSON.parse(Buffer.from(header ?? '', 'base64url').toString())).toMatchObject({ typ: 'JWT', alg: 'HS256' });
  const decoded = JSON.parse(Buffer.from(claims ?? '', 'base64url').toString());

  // The identity is the whole contract with the flow and the page — and it must have NO hyphen.
  expect(decoded.grants.identity).toBe('browser_agent');
  expect(decoded.grants.identity).not.toContain('-');
  // `incomingAllow` is what permits RECEIVING. `outgoingApplicationSid` is deliberately absent: that
  // is the only thing a TwiML Application would be needed for, and we do not place calls from here.
  expect(decoded.grants.voice.incoming.allow).toBe(true);
  expect(decoded.grants.voice.outgoing).toBeUndefined();
  expect(decoded.iss).toBe(API_KEY);
  expect(decoded.sub).toBe(ACCOUNT_SID);
});

test('the token route returns a token and echoes the identity', async () => {
  const app = Fastify() as unknown as App;
  const config = loadConfig(fullEnv);
  const routes = registerHandoffRoutes(app, { config, caps: capabilities(config) });
  routes.setMintToken((identity) =>
    mintVoiceToken({ accountSid: ACCOUNT_SID, apiKey: API_KEY, apiSecret: 'secret', identity }),
  );

  const res = await app.inject({ method: 'POST', url: VOICE_TOKEN_PATH });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.identity).toBe(CLIENT_IDENTITY);
  expect(typeof body.token).toBe('string');
  expect(body.ttlSeconds).toBeGreaterThan(0);
  await app.close();
});

test('an unconfigured process 503s NAMING the variable, and never returns a token', async () => {
  // The house degradation contract. A softphone that gets `{token: undefined}` fails inside the SDK
  // with a message about the token, which sends the reader to the wrong file.
  const app = Fastify() as unknown as App;
  const config = loadConfig({});
  registerHandoffRoutes(app, { config, caps: capabilities(config) });

  const res = await app.inject({ method: 'POST', url: VOICE_TOKEN_PATH });
  expect(res.statusCode).toBe(503);
  const body = res.json();
  expect(body.error).toBe('not_configured');
  expect(JSON.stringify(body.missing)).toContain('TWILIO_ACCOUNT_SID');
  expect(body.token).toBeUndefined();
  await app.close();
});

test('a configured process whose minter was never injected 503s rather than 500s', async () => {
  // Reachable in exactly one real state: Twilio config present but `bootTac` threw, so `server/index.ts`
  // degraded without injecting. The page must be told, not handed a stack trace.
  const app = Fastify() as unknown as App;
  const config = loadConfig(fullEnv);
  registerHandoffRoutes(app, { config, caps: capabilities(config) });

  const res = await app.inject({ method: 'POST', url: VOICE_TOKEN_PATH });
  expect(res.statusCode).toBe(503);
  expect(res.json().error).toBe('not_configured');
  await app.close();
});
