import type { NextConfig } from 'next';
import { AGENT_DEV_ORIGIN } from '../shared/ports.ts';

/**
 * The dev-only proxy that makes browser code identical in development and production.
 *
 * In production the two containers share one public host and Traefik splits by path: `/api`,
 * `/events` and `/health` go to the agent, everything else to Next. So the browser must fetch
 * RELATIVE paths — `/api/bench/turn`, never an origin.
 *
 * Locally there is no Traefik, and Next owns :3000 while the agent owns :8910. Without a rewrite the
 * page has two bad options: hard-code the agent origin (which then has to be stripped for
 * production, and needs CORS — a JSON POST is preflighted, so it fails on the OPTIONS before the
 * handler is ever reached), or run everything behind a local reverse proxy. A rewrite is neither:
 * relative paths resolve to Next, which forwards them, so `fetch('/api/bench/turn')` is correct in
 * both environments and there is no second code path to keep in step.
 *
 * `AGENT_DEV_ORIGIN` is imported from `shared/ports.ts` rather than written out, because a port that
 * disagrees with the server's fails silently in the worst way: the browser gets Next's 404 HTML with
 * a 200 and then dies inside `JSON.parse`.
 *
 * VERIFIED, not assumed: this proxy does not buffer the SSE stream. A rewrite that collected the
 * whole response before forwarding would make every bench turn arrive as one lump at the end with
 * the tokens still correct — indistinguishable from a slow model, and only visible by watching.
 */
const nextConfig: NextConfig = {
  async rewrites() {
    // Guarded so a production build can never quietly point at a developer's laptop.
    if (process.env.NODE_ENV === 'production') return [];
    return [
      { source: '/api/:path*', destination: `${AGENT_DEV_ORIGIN}/api/:path*` },
      { source: '/events/:path*', destination: `${AGENT_DEV_ORIGIN}/events/:path*` },
      { source: '/health', destination: `${AGENT_DEV_ORIGIN}/health` },
    ];
  },
};

export default nextConfig;
