import { expect, test } from 'vitest';
import { TAC, TACConfig, VoiceChannel, twiMLRequestFromForm } from 'twilio-agent-connect';
import { VOICE_ACTION_PATH } from '../shared/handoff.ts';
import { buildVoiceTwimlOptions } from '../server/twilio/voice.ts';

const ACCOUNT = `AC${'0'.repeat(32)}`;
const FLOW = `FW${'1'.repeat(32)}`;
const HOST = 'demo.example.com';

/** Builds a voice channel on a real TAC with a Studio flow configured, and a TwiML request for one inbound call. */
async function channel(defaultTwimlOptions: ReturnType<typeof buildVoiceTwimlOptions> | { reportInputDuringAgentSpeech: 'any' }) {
  const config = new TACConfig({
    accountSid: ACCOUNT,
    authToken: '0'.repeat(32),
    apiKey: `SK${'0'.repeat(32)}`,
    apiSecret: '0'.repeat(32),
    phoneNumber: '+15550000000',
    studioHandoffFlowSid: FLOW,
    voicePublicDomain: HOST,
    voiceWebsocketPath: undefined,
    voiceActionPath: undefined,
    voiceCallEventPath: undefined,
  });
  const tac = await TAC.create({ config });
  const voice = new VoiceChannel(tac, { memoryMode: 'once', defaultTwimlOptions });
  const req = twiMLRequestFromForm({ CallSid: `CA${'2'.repeat(32)}`, From: '+15551112222', To: '+15550000000', AccountSid: ACCOUNT });
  return { voice, req };
}

test('defaultTwimlOptions.actionUrl beats the Studio flow, and an onInboundCallTwiml customizer keeps it', async () => {
  const pinned = await channel(buildVoiceTwimlOptions(HOST));
  expect(await pinned.voice.handleIncomingCall(pinned.req)).toContain(`<Connect action="https://${HOST}${VOICE_ACTION_PATH}">`);

  pinned.voice.onInboundCallTwiml(async () => ({ speechModel: 'flux', eotThreshold: 0.6, extra: { turnDetection: true } }));
  const customized = await pinned.voice.handleIncomingCall(pinned.req);
  expect(customized).toContain(`<Connect action="https://${HOST}${VOICE_ACTION_PATH}">`);
  expect(customized).toContain('speechModel="flux"');
  expect(customized).toContain('eotThreshold="0.6"');
  expect(customized).toContain('turnDetection="true"');
  expect(customized).toContain('reportInputDuringAgentSpeech="any"');

  const unpinned = await channel({ reportInputDuringAgentSpeech: 'any' });
  expect(await unpinned.voice.handleIncomingCall(unpinned.req)).toContain(`/Flows/${FLOW}?Trigger=incomingCall`);
});
