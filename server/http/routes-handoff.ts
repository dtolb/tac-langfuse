/**
 * The two routes the softphone page calls.
 *
 * `POST /api/voice/token`   — a Voice SDK AccessToken for `CLIENT_IDENTITY`
 * `GET  /api/handoff/context` — the screen pop (added in the next task)
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THIS FILE MUST NOT IMPORT `twilio` OR `twilio-agent-connect`.
 *
 * `tests/architecture.test.ts` confines both to `server/twilio/`. The minter is therefore INJECTED:
 * `server/index.ts` calls `setMintToken` at the same point it boots TAC, which also means a process
 * with no Twilio credentials never loads the SDK at all. The seam is a plain function, so this file
 * stays testable with no credentials and no vendor.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
import { unavailable, type AppConfig, type Capabilities, type MissingVar } from '../config.ts';
import { childLogger } from '../logging.ts';
import { CLIENT_IDENTITY, VOICE_TOKEN_PATH, VOICE_TOKEN_TTL_SECONDS } from '../../shared/handoff.ts';
import type { App } from './types.ts';

const log = childLogger('handoff-http');

/** Injected from `server/index.ts`. Returns a signed JWT; never makes a network call. */
export type MintToken = (identity: string) => string;

export interface HandoffRoutes {
  /**
   * Called once, after TAC boots. Late injection rather than a constructor argument because
   * `buildApp()` runs BEFORE any Twilio credential has been proven usable — `TAC.create()` performs a
   * network call that can fail — and the route must answer 503 in the meantime rather than 404.
   */
  setMintToken(mint: MintToken): void;
}

/**
 * The 503 body, naming EVERY variable that blocks voice rather than only the one filed under it.
 *
 * `unavailable(config, 'voice')` alone reports just `TWILIO_VOICE_PUBLIC_DOMAIN`, because that is the
 * only `MissingVar` whose `feature` is `'voice'`. But `capabilities()` computes `voice` as
 * `twilio !== null && voice !== null`, so the five core credentials — filed under `'Twilio'` — block it
 * just as hard. On a fresh clone with nothing configured the unmerged body names the public domain and
 * stays silent about the account SID, which is the wrong first thing to go looking at.
 */
const voiceUnavailable = (config: AppConfig): { error: string; feature: string; missing: readonly MissingVar[] } => {
  const voice = unavailable(config, 'voice');
  return { ...voice, missing: [...unavailable(config, 'Twilio').missing, ...voice.missing] };
};

export function registerHandoffRoutes(
  app: App,
  deps: {
    readonly config: AppConfig;
    readonly caps: Capabilities;
    /** Only tests pass this at construction; production injects via `setMintToken`. */
    readonly mintToken?: MintToken;
  },
): HandoffRoutes {
  let mintToken: MintToken | undefined = deps.mintToken;

  app.post(VOICE_TOKEN_PATH, (_request, reply) => {
    /**
     * `caps.voice` rather than `caps.handoff`, deliberately. The softphone must be able to register
     * BEFORE a Studio flow exists — that is the whole point of the direct-`<Dial>` path, and rung 4 of
     * the verification ladder registers a client with no flow configured at all.
     */
    if (!deps.caps.voice || mintToken === undefined) {
      // Names the missing variable. A softphone handed `{token: undefined}` fails inside the SDK with a
      // message about the token, which sends the reader to the wrong file entirely.
      log.warn(
        { hasVoiceCapability: deps.caps.voice, hasMinter: mintToken !== undefined },
        'voice token requested on a process that cannot mint one',
      );
      void reply.code(503).send(voiceUnavailable(deps.config));
      return;
    }

    // No request body is read. The identity is OURS, not the caller's: letting a client choose its own
    // identity would let any browser register as the agent.
    void reply.code(200).send({
      token: mintToken(CLIENT_IDENTITY),
      identity: CLIENT_IDENTITY,
      ttlSeconds: VOICE_TOKEN_TTL_SECONDS,
    });
  });

  return {
    setMintToken: (mint) => {
      mintToken = mint;
    },
  };
}
