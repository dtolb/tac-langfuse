import { test, expect } from 'vitest';
import Fastify from 'fastify';
import { capabilities, loadConfig } from '../server/config.ts';
import { registerHandoffRoutes } from '../server/http/routes-handoff.ts';
import { mintVoiceToken } from '../server/twilio/voice-token.ts';
import { recordHandoffSnapshot, forgetHandoffSnapshot } from '../server/handoff/snapshots.ts';
import { CLIENT_IDENTITY, HANDOFF_CONTEXT_PATH, VOICE_TOKEN_PATH } from '../shared/handoff.ts';
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

const withContextApp = async (fn: (app: App) => Promise<void>): Promise<void> => {
  const app = Fastify() as unknown as App;
  const config = loadConfig(fullEnv);
  registerHandoffRoutes(app, { config, caps: capabilities(config) });
  await fn(app);
  await app.close();
};

test('the screen pop returns the reason, the transcript and a MASKED number', async () => {
  recordHandoffSnapshot({
    conversationId: 'conv_pop_1',
    reason: 'caller asked for a person',
    from: '+15557778888',
    at: '2026-09-14T10:00:00.000Z',
    transcript: [
      { role: 'user', text: 'I want a human' },
      { role: 'assistant', text: 'Putting you through.' },
    ],
  });

  await withContextApp(async (app) => {
    const res = await app.inject({ method: 'GET', url: `${HANDOFF_CONTEXT_PATH}?conversationId=conv_pop_1` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ found: true, match: 'exact', reason: 'caller asked for a person' });
    // The transcript is VERBATIM by necessity — the human needs the real words. The NUMBER is not.
    expect(body.transcript).toHaveLength(2);
    expect(body.transcript[0]).toEqual({ role: 'user', text: 'I want a human' });
    expect(body.maskedFrom).not.toBe('+15557778888');
    expect(body.maskedFrom).toContain('8888');
    expect(JSON.stringify(body)).not.toContain('+15557778888');
  });

  forgetHandoffSnapshot('conv_pop_1');
});

test('a caller-number lookup works, which is the Studio path', async () => {
  recordHandoffSnapshot({
    conversationId: 'conv_pop_2',
    reason: 'upset caller',
    from: '+15551112222',
    at: '2026-09-14T10:00:00.000Z',
    transcript: [],
  });

  await withContextApp(async (app) => {
    const res = await app.inject({
      method: 'GET',
      url: `${HANDOFF_CONTEXT_PATH}?from=${encodeURIComponent('+15551112222')}`,
    });
    expect(res.json()).toMatchObject({ found: true, match: 'caller', reason: 'upset caller' });
  });

  forgetHandoffSnapshot('conv_pop_2');
});

test('an empty store answers 200 with found:false — never a 404', async () => {
  // The page renders this state. A 404 would land in the browser console as a failed fetch instead.
  await withContextApp(async (app) => {
    const res = await app.inject({ method: 'GET', url: HANDOFF_CONTEXT_PATH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ found: false, match: 'none', reason: null, transcript: [] });
  });
});

test('a query with NO correlator cannot read the last caller off a populated store', async () => {
  /**
   * The one test in this file that is about exposure rather than behaviour. This route is
   * unauthenticated by design and `/api` is what Traefik and the ngrok tunnel route here, so
   * `findHandoffSnapshot`'s `recent` rung — `all.at(-1)` on an empty query — made
   * `curl https://<public-domain>/api/handoff/context` return the newest transcript verbatim, 200 OK,
   * with up to `HANDOFF_MAX_SNAPSHOTS` calls reachable that way.
   *
   * The store above it is deliberately POPULATED, which is what the pre-existing empty-store test could
   * not distinguish: it passed both before and after the guard.
   */
  recordHandoffSnapshot({
    conversationId: 'conv_pop_3',
    reason: 'caller was shouting',
    from: '+15559990000',
    at: '2026-09-14T10:00:00.000Z',
    transcript: [{ role: 'user', text: 'my card number is 4111 1111 1111 1111' }],
  });

  await withContextApp(async (app) => {
    for (const url of [
      HANDOFF_CONTEXT_PATH,
      // An empty value is absent too, or the guard is bypassed by one character.
      `${HANDOFF_CONTEXT_PATH}?from=`,
      `${HANDOFF_CONTEXT_PATH}?conversationId=`,
    ]) {
      const res = await app.inject({ method: 'GET', url });
      // Still 200 with a renderable body — the route's other promise is unchanged.
      expect(res.statusCode, url).toBe(200);
      expect(res.json(), url).toMatchObject({ found: false, match: 'none', transcript: [] });
      expect(res.body, url).not.toContain('4111');
      expect(res.body, url).not.toContain('shouting');
    }

    // And the `recent` rung still works for the case it exists for: a caller number that matched
    // nothing, which is a Studio flow that dropped `caller_id`.
    const withNumber = await app.inject({
      method: 'GET',
      url: `${HANDOFF_CONTEXT_PATH}?from=${encodeURIComponent('+15550000001')}`,
    });
    expect(withNumber.json()).toMatchObject({ found: true, match: 'recent', reason: 'caller was shouting' });
  });

  forgetHandoffSnapshot('conv_pop_3');
});
