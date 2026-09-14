/**
 * The two routes the softphone page calls.
 *
 * `POST /api/voice/token`     — a Voice SDK AccessToken for `CLIENT_IDENTITY`
 * `GET  /api/handoff/context` — the screen pop: why the caller was transferred, and what was said
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
import { findHandoffSnapshot } from '../handoff/snapshots.ts';
import { childLogger } from '../logging.ts';
import { maskPhone } from '../obs/pii.ts';
import {
  CLIENT_IDENTITY,
  HANDOFF_CONTEXT_PATH,
  VOICE_TOKEN_PATH,
  VOICE_TOKEN_TTL_SECONDS,
  type HandoffContextResponse,
} from '../../shared/handoff.ts';
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

  /**
   * The screen pop. NO CAPABILITY GATE and NO 404 — it always answers 200 with a body the page can
   * render, because `found: false` is a state the UI shows ("no context for this call") rather than an
   * error it has to handle. A 404 here would surface in the browser as a failed fetch and send the
   * reader looking for a routing bug.
   *
   * DELIBERATELY NOT a live memory or profile lookup. Conversation Orchestrator extracts observations
   * only AFTER a conversation ends, so for a first-time caller a memory panel would be empty at exactly
   * the moment it is being demoed. What this returns is what the agent just heard, which is always
   * present and always relevant.
   *
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * AT LEAST ONE CORRELATOR IS REQUIRED, and that guard is the only thing standing between this route
   * and a public transcript dump.
   *
   * This route is UNAUTHENTICATED by design (see above), and `/api` is exactly what Traefik and the
   * ngrok tunnel route to this process. `findHandoffSnapshot`'s third rung answers an empty query with
   * `all.at(-1)` — the newest snapshot — so a parameterless `GET /api/handoff/context` returned the
   * last caller's VERBATIM transcript, reason and number with a 200. Snapshots are deliberately not
   * cleared on disconnect and have no TTL, so up to `HANDOFF_MAX_SNAPSHOTS` recent calls were
   * retrievable by one `curl`.
   *
   * The guard lives HERE rather than in `findHandoffSnapshot` because the `recent` rung is correct for
   * the caller that has a number but no match — a Studio flow that dropped the `caller_id` — and it is
   * asserted as such by `tests/handoff.test.ts`. Narrowing the store would change the meaning of the
   * documented three-rung ladder for every caller in order to fix one exposed boundary. The boundary is
   * where the exposure is, so the boundary is where the check goes.
   *
   * Answering `found: false` rather than a 400 keeps the route's other promise: every response is a
   * body the page can render. The softphone always sends `from` on a real ring
   * (`web/src/app/softphone/softphone-client.tsx`), so nothing legitimate reaches this branch.
   *
   * An EMPTY value counts as absent. `?from=` parses to `''`, which is `!= null`, so it would reach the
   * store, match nothing, and land on `recent` — the guard bypassed by one character.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  app.get(HANDOFF_CONTEXT_PATH, (request, reply) => {
    const query = request.query as { conversationId?: string; from?: string };
    const correlator = (value: string | undefined): string | null =>
      value === undefined || value.trim() === '' ? null : value;
    const conversationId = correlator(query.conversationId);
    const from = correlator(query.from);
    const { snapshot, match } =
      conversationId === null && from === null
        ? { snapshot: null, match: 'none' as const }
        : findHandoffSnapshot({ conversationId, from });

    const body: HandoffContextResponse =
      snapshot === null
        ? { found: false, match: 'none', reason: null, conversationId: null, maskedFrom: null, at: null, transcript: [] }
        : {
            found: true,
            match,
            reason: snapshot.reason,
            conversationId: snapshot.conversationId,
            /**
             * MASKED. `../obs/pii.ts` scrubs log lines and obs payloads and does NOT scrub this
             * route's body — so masking has to be explicit, here, at the boundary. The transcript
             * below is verbatim on purpose: the human agent needs the real words, and the design doc
             * §10 states that as a new PII surface rather than hiding it.
             */
            maskedFrom: snapshot.from === null ? null : maskPhone(snapshot.from),
            at: snapshot.at,
            transcript: snapshot.transcript,
          };

    void reply.code(200).send(body);
  });

  return {
    setMintToken: (mint) => {
      mintToken = mint;
    },
  };
}
