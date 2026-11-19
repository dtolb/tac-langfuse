/**
 * Home page: the ways into the running demo — the phone number, the browser pages, and the
 * observability links — with each one's availability read live from the agent's `/health`.
 *
 * A SERVER component wrapping one client island, the shape `/bench` and `/softphone` use. The
 * web container receives no environment at all, so the phone number and Langfuse host cannot be
 * read here; they come from `/health`, which also keeps the page from claiming a channel the agent
 * has not actually started.
 */
import { Typography } from '@gtmi/strix-react/atoms/typography';
import { Separator } from '@gtmi/strix-react/atoms/separator';
import { HomeStatus } from './home-status.tsx';

export default function Page() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-8" data-testid="home">
      {/* `as` rather than render={<h1/>}: an element crossing the server→client boundary via
          a render prop arrives without props and blanks the page after hydration. */}
      <Typography variant="h2" as="h1">
        Demo Agent
      </Typography>
      <Typography variant="body-m-regular" as="p" className="text-text-secondary">
        One AI agent on voice, SMS and the browser. Every turn is traced in Langfuse, and its prompts and
        tools are edited there without a redeploy.
      </Typography>

      <Separator />

      <HomeStatus />
    </main>
  );
}
