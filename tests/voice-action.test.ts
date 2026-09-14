import { test, expect } from 'vitest';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { buildActionTwiml, registerVoiceActionRoutes } from '../server/http/routes-voice-action.ts';
import { capabilities, loadConfig } from '../server/config.ts';
import { createObsBus } from '../server/obs/bus.ts';
import { VOICE_ACTION_PATH, CLIENT_IDENTITY } from '../shared/handoff.ts';
import type { App } from '../server/http/types.ts';
import type { ObsEvent } from '../shared/events.ts';

const ACCOUNT_SID = 'AC' + 'a'.repeat(32);
const FLOW_SID = 'FW' + 'b'.repeat(32);
const handoffData = JSON.stringify({
  conversationId: 'conv_action_1',
  storeId: 'store_x',
  profileId: 'profile_x',
  attributes: { reasonCode: 'live-agent-handoff', reason: 'caller asked for a person' },
});

test('with a flow SID configured it redirects to Studio', () => {
  const { twiml, route } = buildActionTwiml({ handoffData, accountSid: ACCOUNT_SID, flowSid: FLOW_SID });
  expect(route).toBe('studio');
  // TAC's own `studioVoiceHandoffUrl` shape, written out here because this module may not import TAC.
  expect(twiml).toContain(
    `https://webhooks.twilio.com/v1/Accounts/${ACCOUNT_SID}/Flows/${FLOW_SID}?Trigger=incomingCall`,
  );
  expect(twiml).toContain('<Redirect method="POST">');
});

test('with no flow SID it dials the browser client and carries the conversation id', () => {
  const { twiml, route } = buildActionTwiml({ handoffData, accountSid: ACCOUNT_SID, flowSid: null });
  expect(route).toBe('client');
  expect(twiml).toContain(`<Identity>${CLIENT_IDENTITY}</Identity>`);
  // The ONLY path that gets exact screen-pop correlation, because it is the only one that can: the
  // Studio connect-call-to widget cannot pass parameters to a client.
  expect(twiml).toContain('<Parameter name="conversationId" value="conv_action_1"/>');
  expect(twiml).toContain('answerOnBridge="true"');
  // A no-answer must not leave the call in limbo after the dial times out.
  expect(twiml.indexOf('</Dial>')).toBeLessThan(twiml.indexOf('<Hangup/>'));
});

test('no HandoffData means the end_call path, which hangs up cleanly', () => {
  const { twiml, route } = buildActionTwiml({ handoffData: undefined, accountSid: ACCOUNT_SID, flowSid: FLOW_SID });
  expect(route).toBe('hangup');
  expect(twiml).toContain('<Hangup/>');
  expect(twiml).not.toContain('Redirect');
});

test('UNPARSEABLE HandoffData hangs up rather than throwing', () => {
  // A throw here is a dropped call with a TwiML error in the debugger. This is the assertion that
  // keeps the route's promise — valid TwiML on EVERY path.
  const { twiml, route } = buildActionTwiml({ handoffData: 'not json{{{', accountSid: ACCOUNT_SID, flowSid: FLOW_SID });
  expect(route).toBe('hangup');
  expect(twiml).toContain('<Hangup/>');
});

test('a missing account SID cannot produce a half-built Studio URL', () => {
  // Falls back to the client path rather than emitting `Accounts/null/Flows/...`, which Twilio would
  // answer with a 404 the caller experiences as silence.
  const { route } = buildActionTwiml({ handoffData, accountSid: null, flowSid: FLOW_SID });
  expect(route).toBe('client');
});

test('the route answers XML with a 200 and publishes one handoff event', async () => {
  const events: ObsEvent[] = [];
  const bus = createObsBus();
  bus.subscribe((e) => events.push(e));

  const app = Fastify() as unknown as App;
  await app.register(formbody);
  const config = loadConfig({
    TWILIO_ACCOUNT_SID: ACCOUNT_SID,
    TWILIO_AUTH_TOKEN: 'token',
    TWILIO_API_KEY: 'SK' + 'c'.repeat(32),
    TWILIO_API_SECRET: 'secret',
    TWILIO_PHONE_NUMBER: '+15550001111',
    TWILIO_VOICE_PUBLIC_DOMAIN: 'demo.test',
    TWILIO_CONVERSATION_CONFIGURATION_ID: 'conv_configuration_' + 'a'.repeat(26),
    TWILIO_STUDIO_HANDOFF_FLOW_SID: FLOW_SID,
  });
  registerVoiceActionRoutes(app, { config, caps: capabilities(config), bus });

  const res = await app.inject({
    method: 'POST',
    url: VOICE_ACTION_PATH,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      AccountSid: ACCOUNT_SID,
      CallSid: 'CA' + 'd'.repeat(32),
      CallStatus: 'in-progress',
      From: '+15557778888',
      To: '+15550001111',
      SessionStatus: 'ended',
      SessionDuration: '25',
      HandoffData: handoffData,
    }).toString(),
  });

  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toContain('text/xml');
  expect(res.body).toContain('<Redirect method="POST">');
  const published = events.find((e) => e.kind === 'handoff');
  expect(published?.payload).toMatchObject({ route: 'studio', reasonCode: 'live-agent-handoff' });
  await app.close();
});

test('a failed session is logged and hung up, not redirected', async () => {
  const bus = createObsBus();
  const app = Fastify() as unknown as App;
  await app.register(formbody);
  const config = loadConfig({ TWILIO_STUDIO_HANDOFF_FLOW_SID: FLOW_SID });
  registerVoiceActionRoutes(app, { config, caps: capabilities(config), bus });

  const res = await app.inject({
    method: 'POST',
    url: VOICE_ACTION_PATH,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      SessionStatus: 'failed',
      ErrorCode: '64105',
      ErrorMessage: 'WebSocket Ended',
    }).toString(),
  });

  expect(res.statusCode).toBe(200);
  expect(res.body).toContain('<Hangup/>');
  await app.close();
});
