'use client';

/**
 * The agent's phone number as a `tel:` link, for any page where the next step is placing a call.
 *
 * Reads `phoneNumber` from `/health` with a RELATIVE fetch, the same path `home-status.tsx` uses, so
 * the number on every page is whatever the running agent is configured with rather than a literal.
 */
import { useEffect, useState } from 'react';
import { Typography } from '@gtmi/strix-react/atoms/typography';

/** Formats a NANP E.164 number as `+1 555-123-4567`; any other number is returned unchanged. */
export const formatPhone = (e164: string): string => {
  const m = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `+1 ${m[1]}-${m[2]}-${m[3]}` : e164;
};

/** Renders "Call the agent: <number>", or nothing until `/health` answers with a number. */
export function CallNumber({ hint }: { readonly hint?: string }) {
  const [phone, setPhone] = useState<string | null>(null);

  useEffect(() => {
    fetch('/health')
      .then((r) => (r.ok ? (r.json() as Promise<{ phoneNumber: string | null }>) : null))
      .then((h) => setPhone(h?.phoneNumber ?? null))
      .catch(() => undefined);
  }, []);

  if (!phone) return null;
  return (
    <Typography variant="body-l" as="p" data-testid="call-number">
      Call the agent:{' '}
      <a className="text-text-accent font-semibold underline underline-offset-2" href={`tel:${phone}`}>
        {formatPhone(phone)}
      </a>
      {hint && <span className="text-text-secondary"> — {hint}</span>}
    </Typography>
  );
}
