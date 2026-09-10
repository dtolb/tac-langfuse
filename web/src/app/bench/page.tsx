/**
 * `/bench` — the Twilio-free harness.
 *
 * A SERVER component wrapping one client island, matching the shape spike S2 verified: Strix renders
 * from the server, and only the part that needs state and a fetch carries `'use client'`.
 *
 * This page is for whoever is building the demo, not for the customer — T18 owns the customer-facing
 * page. Its value is that prompt iteration becomes a many-turns-per-minute activity: editing a prompt
 * version in Langfuse and pressing enter here, instead of placing a phone call for every change.
 */
import { Typography } from '@gtmi/strix-react/atoms/typography';
import { Separator } from '@gtmi/strix-react/atoms/separator';
import { BenchChat } from './bench-chat.tsx';

export default function BenchPage() {
  return (
    <main className="mx-auto flex h-dvh w-full max-w-3xl flex-col gap-4 p-8" data-testid="bench">
      {/* `as` rather than a render prop: an element crossing the server→client boundary that way
          arrives without props and blanks the page after hydration — the S2 gotcha `pnpm smoke`
          exists to catch. */}
      <Typography variant="h3" as="h1">
        Bench
      </Typography>
      <Typography variant="body-s" as="p" className="text-text-secondary">
        The same agent voice and SMS will use, driven over HTTP. If this answers, the agent core works
        independently of Twilio.
      </Typography>

      <Separator />

      <BenchChat />
    </main>
  );
}
