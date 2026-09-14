/**
 * The Voice SDK AccessToken — the only new file in the repo that imports the raw `twilio` package.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * IT LIVES HERE BECAUSE OF AN ARCHITECTURE RULE, NOT A PREFERENCE.
 *
 * `tests/architecture.test.ts` confines `twilio` to `server/twilio/` and `scripts/`, for the same
 * reason it confines `twilio-agent-connect`. The design doc put this in `server/http/`, which would
 * fail the build. `server/http/routes-handoff.ts` therefore receives a `mintToken` FUNCTION injected
 * at boot — so a process with no Twilio credentials never loads this module, and never loads `twilio`.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * NO API PERMISSION IS REQUIRED to mint one of these: it is a locally signed JWT, and the exported key
 * carries the `signing` flag. This matters because the long-standing 70004 on `accounts list` looks
 * like a restricted key and is not — that error is the absence of `manage_keys`/`manage_accounts`.
 * Nothing here makes a network call, which is also why it is trivially testable.
 *
 * NO TwiML APPLICATION, and this is the field that proves it: `outgoingApplicationSid` is optional in
 * `VoiceGrantOptions`, and a TwiML App is an OUTGOING-only requirement. `incomingAllow: true` is what
 * permits RECEIVING a call. So the softphone needs zero account mutations. Three TwiML Applications do
 * exist on this account; none belongs to this scaffold.
 *
 * TAC will not do this for us — its dist contains ZERO `AccessToken` references (checked in 2.2.0).
 */
import twilio from 'twilio';
import { VOICE_TOKEN_TTL_SECONDS } from '../../shared/handoff.ts';

export interface MintVoiceTokenDeps {
  readonly accountSid: string;
  readonly apiKey: string;
  readonly apiSecret: string;
  /** `CLIENT_IDENTITY`. Passed rather than imported so a test can prove the charset rule. */
  readonly identity: string;
  readonly ttlSeconds?: number;
}

export function mintVoiceToken(deps: MintVoiceTokenDeps): string {
  const { AccessToken } = twilio.jwt;
  const { VoiceGrant } = AccessToken;

  const token = new AccessToken(deps.accountSid, deps.apiKey, deps.apiSecret, {
    identity: deps.identity,
    ttl: deps.ttlSeconds ?? VOICE_TOKEN_TTL_SECONDS,
  });

  token.addGrant(
    new VoiceGrant({
      // The whole grant. See the header on why there is no `outgoingApplicationSid`.
      incomingAllow: true,
    }),
  );

  return token.toJwt();
}
