/**
 * Placeholder home page. T18 replaces this with the customer-facing demo (branded as the
 * customer, no Twilio jargon) and T19 adds the operator console.
 *
 * It exists now to prove three things at once: Strix renders from a SERVER component, the
 * shared/ contract is importable across the project boundary, and the token utilities
 * actually resolve. All three fail silently otherwise.
 */
import { Typography } from '@gtmi/strix-react/atoms/typography';
import { Badge } from '@gtmi/strix-react/atoms/badge';
import { Separator } from '@gtmi/strix-react/atoms/separator';
import { MetricList } from '@gtmi/strix-react/atoms/metric-list';
import { AGENT_PORT, WEB_PORT, LANGFUSE_HOST_PORT } from '../../../shared/ports.ts';

export default function Page() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-8" data-testid="home">
      {/* `as` rather than render={<h1/>}: an element crossing the server→client boundary via
          a render prop arrives without props and blanks the page after hydration. */}
      <Typography variant="h2" as="h1">
        Demo Scaffold
      </Typography>

      <div className="flex gap-2">
        <Badge label="scaffold" variant="feature" />
        <Badge label="not yet configured" variant="neutral" />
      </div>

      <Separator />

      <Typography variant="body-m-regular" as="p">
        Foundation only. The agent, TAC channels, and operator console are not wired yet.
      </Typography>

      {/* Imported from shared/, not retyped — the whole point of that directory. */}
      <MetricList
        groups={[
          {
            heading: 'Ports',
            metrics: [
              { label: 'Agent (TAC + API + SSE)', value: AGENT_PORT },
              { label: 'Web (this app)', value: WEB_PORT },
              { label: 'Langfuse', value: LANGFUSE_HOST_PORT },
            ],
          },
        ]}
      />
    </main>
  );
}
