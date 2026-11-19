'use client';

/**
 * The live half of the home page. Fetches `/health` once on mount and renders each entry point with
 * whether the agent reports it as available.
 *
 * `/health` is a RELATIVE fetch: Traefik routes it to the agent in the container, and the Next
 * rewrite in `next.config.ts` forwards it in development, so this file has one code path for both.
 */
import { useEffect, useState } from 'react';
import { Badge } from '@gtmi/strix-react/atoms/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@gtmi/strix-react/atoms/card';
import { InfoRow } from '@gtmi/strix-react/atoms/info-row';
import { Typography } from '@gtmi/strix-react/atoms/typography';

/** The subset of the agent's `/health` body this page reads (`server/http/app.ts`). */
interface Health {
  readonly appName: string;
  readonly phoneNumber: string | null;
  readonly langfuseUrl: string | null;
  readonly capabilities: Record<string, boolean>;
  readonly missing: readonly string[];
}

type Load = { state: 'loading' } | { state: 'ok'; health: Health } | { state: 'error' };

/** Formats a NANP E.164 number as `+1 555-123-4567`; any other number is returned unchanged. */
const formatPhone = (e164: string): string => {
  const m = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `+1 ${m[1]}-${m[2]}-${m[3]}` : e164;
};

/** A green or grey badge for one capability, or nothing while `/health` is still loading. */
function Availability({ on }: { readonly on: boolean | undefined }) {
  if (on === undefined) return null;
  return <Badge label={on ? 'live' : 'not configured'} variant={on ? 'success' : 'neutral'} size="small" />;
}

/** One entry point: a title, an availability badge, a description, and its link or number. */
function Entry(props: {
  readonly title: string;
  readonly on: boolean | undefined;
  readonly description: string;
  readonly children: React.ReactNode;
}) {
  return (
    <Card variant="elevated" padding="md">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle as="h2">{props.title}</CardTitle>
          <Availability on={props.on} />
        </div>
        <CardDescription>{props.description}</CardDescription>
      </CardHeader>
      <CardContent>{props.children}</CardContent>
    </Card>
  );
}

const linkClass = 'text-text-accent underline underline-offset-2';

export function HomeStatus() {
  const [load, setLoad] = useState<Load>({ state: 'loading' });

  useEffect(() => {
    fetch('/health')
      .then((r) => (r.ok ? (r.json() as Promise<Health>) : Promise.reject(new Error(String(r.status)))))
      .then((health) => setLoad({ state: 'ok', health }))
      .catch(() => setLoad({ state: 'error' }));
  }, []);

  const health = load.state === 'ok' ? load.health : null;
  const caps = health?.capabilities;
  const phone = health?.phoneNumber ?? null;

  return (
    <div className="flex flex-col gap-4" data-testid="home-status">
      {load.state === 'error' && (
        <Typography variant="body-s" as="p" className="text-text-error">
          The agent did not answer /health, so nothing below can be reached right now.
        </Typography>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Entry
          title="Call the agent"
          on={caps?.voice}
          description="ConversationRelay voice. Ask about an order (try A4721), store hours, or for a person."
        >
          {phone ? (
            <a className={`${linkClass} text-lg`} href={`tel:${phone}`}>
              {formatPhone(phone)}
            </a>
          ) : (
            <InfoRow label="Number" value={null} />
          )}
        </Entry>

        <Entry
          title="Text the agent"
          on={caps?.sms}
          description="SMS to the same number. Use a phone outside this Twilio account, or every reply arrives twice."
        >
          {phone ? (
            <a className={`${linkClass} text-lg`} href={`sms:${phone}`}>
              {formatPhone(phone)}
            </a>
          ) : (
            <InfoRow label="Number" value={null} />
          )}
        </Entry>

        <Entry
          title="Softphone"
          on={caps?.handoff}
          description="Register here, then ask the agent for a person on a call. This rings with the reason and the transcript so far."
        >
          <a className={linkClass} href="/softphone">
            Open the softphone
          </a>
        </Entry>

        <Entry
          title="Bench"
          on={caps?.llm}
          description="The same agent in a chat box, with no phone involved. Shows prompt version, tools called, and timings per turn."
        >
          <a className={linkClass} href="/bench">
            Open the bench
          </a>
        </Entry>

        <Entry
          title="Tuning"
          on={caps?.voice}
          description="ConversationRelay speech-to-text, voice and turn-taking settings, applied to live calls mid-call, with each call's per-turn timeline."
        >
          <a className={linkClass} href="/tuning">
            Open tuning
          </a>
        </Entry>

        <Entry
          title="Live events"
          on={health ? true : undefined}
          description="Server-sent events for every webhook, turn and tool call, as they happen."
        >
          <a className={linkClass} href="/events/stream" target="_blank" rel="noreferrer">
            /events/stream
          </a>
        </Entry>

        <Entry
          title="Traces and prompts"
          on={caps?.prompts}
          description="Langfuse: one trace per conversation, and the versioned prompts that choose each channel's model and tools."
        >
          {health?.langfuseUrl ? (
            <a className={linkClass} href={health.langfuseUrl} target="_blank" rel="noreferrer">
              {new URL(health.langfuseUrl).host}
            </a>
          ) : (
            <InfoRow label="Langfuse" value={null} />
          )}
        </Entry>
      </div>

      {health && health.missing.length > 0 && (
        <Typography variant="body-s" as="p" className="text-text-secondary">
          Unset on the agent: {health.missing.join(', ')}
        </Typography>
      )}
    </div>
  );
}
