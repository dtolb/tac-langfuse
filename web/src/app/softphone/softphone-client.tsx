'use client';

/**
 * The softphone itself: register, ring, screen-pop, answer.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `@twilio/voice-sdk` IS IMPORTED DYNAMICALLY, AND THAT IS NOT AN OPTIMISATION.
 *
 * The module emits a `console.warn` at LOAD time in a non-browser context, so a static top-level
 * import would fire on every server-side render pass of this route — noise in the server log that
 * looks like an application warning. It also touches browser globals. `await import()` inside an
 * effect keeps it strictly client-side.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * EVERY FETCH USES A RELATIVE PATH. In production Traefik splits one public host by path; in
 * development `web/next.config.ts` rewrites `/api/*` to the agent on :8910. Naming an origin here
 * would need CORS (a JSON POST is preflighted, so it fails on the OPTIONS) and would then have to be
 * stripped for production.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CLIENT_IDENTITY,
  HANDOFF_CONTEXT_PATH,
  VOICE_TOKEN_PATH,
  type HandoffContextResponse,
} from '../../../../shared/handoff.ts';

type Status = 'idle' | 'registering' | 'registered' | 'ringing' | 'on-call' | 'error';

/** Just the members this file touches, so the vendor's types never reach the component signature. */
interface IncomingCall {
  readonly parameters: Record<string, string>;
  customParameters: Map<string, string>;
  accept(): void;
  disconnect(): void;
  on(event: string, handler: () => void): void;
}

export function SoftphoneClient() {
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [context, setContext] = useState<HandoffContextResponse | null>(null);
  const [callerNumber, setCallerNumber] = useState<string | null>(null);
  const deviceRef = useRef<{ register(): Promise<void>; destroy(): void; updateToken(t: string): void; on(e: string, h: (a?: unknown) => void): void } | null>(null);
  const callRef = useRef<IncomingCall | null>(null);

  const fetchToken = useCallback(async (): Promise<string> => {
    const res = await fetch(VOICE_TOKEN_PATH, { method: 'POST' });
    if (!res.ok) {
      // The route 503s NAMING the missing variable, so surfacing the body is what makes a
      // half-configured process diagnosable from the page instead of from the server log.
      const body = (await res.json().catch(() => ({}))) as { missing?: { name: string }[] };
      const names = (body.missing ?? []).map((m) => m.name).join(', ');
      throw new Error(names === '' ? `token request failed (${res.status})` : `not configured: ${names}`);
    }
    return ((await res.json()) as { token: string }).token;
  }, []);

  /**
   * The screen pop. Tried by `conversationId` first — the direct-`<Dial>` path carries it as a
   * `<Parameter>`, which the SDK surfaces as `call.customParameters` — then by the caller's number,
   * which is all the Studio path can offer because its `connect-call-to` widget cannot pass parameters
   * to a client and dialling a client mints a new CallSid.
   */
  const loadContext = useCallback(async (conversationId: string | null, from: string | null) => {
    const params = new URLSearchParams();
    if (conversationId !== null) params.set('conversationId', conversationId);
    if (from !== null) params.set('from', from);
    const res = await fetch(`${HANDOFF_CONTEXT_PATH}?${params.toString()}`);
    // Always 200 with a renderable body, so there is no error branch to write here.
    setContext((await res.json()) as HandoffContextResponse);
  }, []);

  const register = useCallback(async () => {
    setStatus('registering');
    setError(null);
    try {
      const { Device } = await import('@twilio/voice-sdk');
      const token = await fetchToken();

      /**
       * NO TOKEN-REFRESH OPTION SET, deliberately. Twilio's documentation spells it both
       * `tokenRefreshMs` and `refreshTokenMs`, and the installed SDK carries BOTH spellings itself:
       * in `es5/twilio/device.d.ts` the option is declared `tokenRefreshMs?: number` (line 915) while
       * the doc comment on the `tokenWillExpire` event tells you to use `DeviceOptions.refreshTokenMs`
       * (line 617). Since `Device.Options` is not an exact type, the wrong name would compile and set
       * nothing. The default already fires `tokenWillExpire` 10 s before expiry, which is all the
       * handler below needs.
       */
      const device = new Device(token) as unknown as NonNullable<typeof deviceRef.current>;
      deviceRef.current = device;

      device.on('registered', () => setStatus('registered'));
      device.on('unregistered', () => setStatus('idle'));
      device.on('error', (err) => {
        setStatus('error');
        setError(err instanceof Error ? err.message : String(err));
      });

      // A token that quietly expires takes the softphone offline with nothing on screen to say why.
      //
      // The `.catch` is the whole point of the handler. Without it a failed refresh is an unhandled
      // rejection, the Device goes offline the moment the old token expires, and the UI still reads
      // `registered` — the exact silent-offline failure this handler exists to prevent.
      device.on('tokenWillExpire', () => {
        void fetchToken()
          .then((fresh) => device.updateToken(fresh))
          .catch((err: unknown) => {
            setStatus('error');
            setError(err instanceof Error ? `token refresh failed: ${err.message}` : String(err));
          });
      });

      device.on('incoming', (incoming) => {
        const call = incoming as IncomingCall;
        callRef.current = call;
        setStatus('ringing');
        const from = call.parameters.From ?? null;
        setCallerNumber(from);
        void loadContext(call.customParameters.get('conversationId') ?? null, from);

        // Both endings, or a cancelled call leaves the UI ringing forever.
        call.on('disconnect', () => {
          callRef.current = null;
          setStatus('registered');
        });
        call.on('cancel', () => {
          callRef.current = null;
          setStatus('registered');
        });
      });

      await device.register();
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [fetchToken, loadContext]);

  // One identity allows 10 concurrent registrations and the 11th EVICTS THE OLDEST, so a page that
  // leaked a Device on every hot reload would silently steal its own registration.
  useEffect(() => () => deviceRef.current?.destroy(), []);

  const answer = (): void => {
    callRef.current?.accept();
    setStatus('on-call');
  };
  const hangUp = (): void => callRef.current?.disconnect();

  return (
    <section className="flex flex-col gap-4" data-testid="softphone-client">
      <div className="flex items-center gap-3">
        <span className="text-sm text-text-secondary">
          {CLIENT_IDENTITY} — {status}
        </span>
        {status === 'idle' || status === 'error' ? (
          <button type="button" onClick={() => void register()} className="rounded border px-3 py-1 text-sm">
            Register
          </button>
        ) : null}
      </div>

      {error === null ? null : (
        <p className="text-sm text-red-600" data-testid="softphone-error">
          {error}
        </p>
      )}

      {status === 'ringing' || status === 'on-call' ? (
        <div className="flex flex-col gap-3 rounded border p-4" data-testid="screen-pop">
          <p className="text-sm">
            Incoming call{callerNumber === null ? '' : ` from ${callerNumber}`}
          </p>
          {context?.found === true ? (
            <>
              <p className="text-sm font-medium">Why: {context.reason}</p>
              {/* The match quality is SHOWN, not hidden: `recent` can be the wrong call under load, and
                  a human reading a transcript needs to know how confident the correlation was.

                  `context.maskedFrom` is deliberately NOT rendered. The line above already shows
                  `call.parameters.From` in full — a human agent about to speak to this person needs the
                  real number — so printing the masked copy two lines below it defeated nothing and read
                  as a bug. The masking in `server/http/routes-handoff.ts` still matters: it is what keeps
                  the number out of the response body for every other consumer of that route. */}
              <p className="text-xs text-text-secondary">matched on {context.match}</p>
              <ol className="flex flex-col gap-1 text-sm">
                {context.transcript.map((turn, i) => (
                  <li key={i}>
                    <strong>{turn.role === 'user' ? 'Caller' : 'Agent'}:</strong> {turn.text}
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <p className="text-sm text-text-secondary">No context for this call.</p>
          )}
          <div className="flex gap-2">
            {status === 'ringing' ? (
              <button type="button" onClick={answer} className="rounded border px-3 py-1 text-sm">
                Answer
              </button>
            ) : null}
            <button type="button" onClick={hangUp} className="rounded border px-3 py-1 text-sm">
              Hang up
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
