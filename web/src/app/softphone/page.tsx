/**
 * `/softphone` — where a human answers a transferred call.
 *
 * A SERVER component wrapping one client island, the shape spike S2 verified and `/bench` already
 * uses: Strix renders from the server, and only the part that needs state, a fetch and a WebRTC device
 * carries `'use client'`.
 *
 * This page is the reason the transfer is demonstrable at all — until a client is registered as
 * `browser_agent` there is nothing for the flow to dial.
 */
import { Typography } from '@gtmi/strix-react/atoms/typography';
import { Separator } from '@gtmi/strix-react/atoms/separator';
import { SoftphoneClient } from './softphone-client.tsx';

export default function SoftphonePage() {
  return (
    <main className="mx-auto flex h-dvh w-full max-w-3xl flex-col gap-4 p-8" data-testid="softphone">
      {/* `as` rather than a render prop — an element crossing the server→client boundary that way
          arrives without props and blanks the page after hydration (the S2 gotcha). */}
      <Typography variant="h3" as="h1">
        Softphone
      </Typography>
      <Typography variant="body-s" as="p" className="text-text-secondary">
        Register, then wait. When the agent transfers a caller, this rings and shows why they were
        transferred plus what was already said.
      </Typography>

      <Separator />

      <SoftphoneClient />
    </main>
  );
}
