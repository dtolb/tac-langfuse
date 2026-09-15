import { join } from 'node:path';
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
/**
 * The repo root, one level up from `web/`.
 *
 * Derived rather than written as a literal because it differs by environment — `/app` in the
 * container, `~/code/demo-building-tools/scaffold` on the host — and `outputFileTracingRoot`
 * takes an absolute path. `import.meta.dirname` rather than `process.cwd()` because the answer
 * must depend on where this FILE is, not on which directory `next build` was invoked from.
 */
const REPO_ROOT = join(import.meta.dirname, '..');

const nextConfig: NextConfig = {
  /**
   * Required for the container, and required BECAUSE of the out-of-root imports above, not
   * despite them.
   *
   * `next start` loads this config file at RUNTIME. This file imports `../shared/ports.ts`,
   * which lives outside `web/` and is therefore not in the deployed subtree — so a `next start`
   * image dies at boot on ERR_MODULE_NOT_FOUND. Standalone resolves the config at BUILD time and
   * emits a self-contained `server.js`, so the runtime never reads this file at all.
   *
   * Two consequences that are near-silent if you skip them, both handled in Dockerfile.web:
   *   1. with the tracing root above the project, the entry is `.next/standalone/web/server.js`,
   *      NOT `.next/standalone/server.js` (next/dist/build/utils.js — `path.relative()`);
   *   2. standalone does NOT copy `public/` or `.next/static/`, so without a hand-copy the HTML
   *      renders looking roughly right while every JS/CSS chunk 404s and React never hydrates —
   *      the bench and softphone become dead buttons with no server-side error.
   */
  output: 'standalone',

  /**
   * Without this, tracing roots at `web/` and the `../shared/*.ts` imports fall outside it, so
   * they are silently omitted from the standalone bundle.
   */
  outputFileTracingRoot: REPO_ROOT,

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
