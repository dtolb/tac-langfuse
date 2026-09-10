// What is running, what is configured, and what is therefore possible right now.
//   pnpm status
//
// Written because the answer spans three places — two node processes, six containers, and a
// .env file — and checking them by hand invites the assumption that something is up when it
// isn't. Read-only: starts nothing, changes nothing.
import { createConnection } from 'node:net';
import { readFileSync, existsSync } from 'node:fs';

const AGENT_PORT = 8910; // must match shared/ports.ts (this file is .mjs, outside tsconfig)
const WEB_PORT = 3000;
const LANGFUSE_PORT = 3100;

const G = '\x1b[32m';
const R = '\x1b[31m';
const Y = '\x1b[33m';
const D = '\x1b[2m';
const X = '\x1b[0m';

const listening = (port) =>
  new Promise((resolve) => {
    const sock = createConnection({ port, host: '127.0.0.1' });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(400);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });

const getJson = async (url) => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
};

const dot = (ok) => (ok ? `${G}●${X}` : `${R}○${X}`);
// The detail is the REASON something is off, so it must not print when it is on — otherwise
// a healthy row reads "● llm  missing config", which is worse than saying nothing.
const row = (label, ok, detail = '') =>
  console.log(`  ${dot(ok)} ${label.padEnd(26)}${ok ? '' : `${D}${detail}${X}`}`);

console.log('\n\x1b[1mSERVICES\x1b[0m');

const agentUp = await listening(AGENT_PORT);
row(`agent  :${AGENT_PORT}`, agentUp, agentUp ? '' : 'start with:  pnpm dev');

const webUp = await listening(WEB_PORT);
row(`web    :${WEB_PORT}`, webUp, webUp ? '' : 'start with:  pnpm dev:web');

const lfUp = await listening(LANGFUSE_PORT);
row(
  `langfuse:${LANGFUSE_PORT}`,
  lfUp,
  lfUp ? '' : 'start with:  docker compose -f docker-compose.langfuse.yml up -d',
);

if (lfUp) {
  const health = await getJson(`http://localhost:${LANGFUSE_PORT}/api/public/health`);
  console.log(`     ${D}api health: ${health ? 'ok' : 'not ready yet (ClickHouse migrations take 2-3 min on first boot)'}${X}`);
}

// ---- capabilities, straight from the running agent so it cannot disagree with reality ----
console.log('\n\x1b[1mCAPABILITIES\x1b[0m');
if (!agentUp) {
  console.log(`  ${D}agent not running — start it to see what is wired${X}`);
} else {
  const health = await getJson(`http://localhost:${AGENT_PORT}/health`);
  if (!health) {
    console.log(`  ${R}agent is listening but /health did not answer${X}`);
  } else {
    for (const [name, ok] of Object.entries(health.capabilities ?? {})) {
      row(name, ok, 'missing config');
    }
    if (health.missing?.length) {
      console.log(`\n  ${Y}unset:${X} ${health.missing.join(', ')}`);
    }
    console.log(`  ${D}APP_NAME=${health.appName}${X}`);
    if (health.appName === 'scaffold') {
      console.log(
        `  ${Y}warning${X} APP_NAME is still the default. Traefik router names are global on the`,
      );
      console.log(`          dev box, so two clones left as 'scaffold' fight over webhooks.`);
    }
  }
}

// ---- config on disk, independent of whether anything is running ----
console.log('\n\x1b[1mCONFIG\x1b[0m');
if (!existsSync('.env')) {
  console.log(`  ${R}○${X} .env missing            ${D}cp .env.example .env${X}`);
} else {
  const names = readFileSync('.env', 'utf8')
    .split('\n')
    .map((l) => l.match(/^([A-Z][A-Z0-9_]*)=(.*)$/))
    .filter((m) => m && m[2].trim() !== '')
    .map((m) => m[1]);
  console.log(`  ${G}●${X} .env present            ${D}${names.length} value(s) set: ${names.join(', ')}${X}`);
}

console.log('\n\x1b[1mURLS\x1b[0m');
console.log(`  ${D}web       ${X}http://localhost:${WEB_PORT}`);
console.log(`  ${D}health    ${X}http://localhost:${AGENT_PORT}/health`);
console.log(`  ${D}langfuse  ${X}http://localhost:${LANGFUSE_PORT}`);
console.log(`\n${D}build progress: ~/.claude/plans/i-want-to-build-reactive-muffin.md${X}`);
console.log(`${D}checks:         pnpm typecheck && pnpm test${X}\n`);
