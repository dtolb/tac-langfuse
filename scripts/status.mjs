// What is running, what is configured, and what is therefore possible right now.
//   pnpm status
//
// Written because the answer spans three places — two node processes, six containers, and a
// .env file — and checking them by hand invites the assumption that something is up when it
// isn't. Read-only: starts nothing, changes nothing.
//
// T15 ADDED A SECOND WAY TO RUN THIS APP, and that broke an assumption this file was built on:
// it used to equate "something is listening on 8910" with "the agent is up". Containerised, the
// agent deliberately publishes NO host ports (only Traefik binds ports on the dev box), so both
// probes go dark while the app is perfectly healthy. Reporting that as red would train you to
// ignore this output. So there are now two independent sections — host processes and containers —
// and capabilities are read from whichever one answers.
import { createConnection } from 'node:net';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

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
    const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
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

// ---- .env, parsed once. Both the CONFIG section and the container/URL sections need it, and
// ---- APP_NAME in particular decides the hostname, so it must come from the FILE rather than the
// ---- shell: compose interpolates labels from the file too, and a shell-only export would make
// ---- this report disagree with what Traefik actually serves.
const envText = existsSync('.env') ? readFileSync('.env', 'utf8') : null;
const envFile = new Map(
  (envText ?? '')
    .split('\n')
    .map((l) => l.match(/^([A-Z][A-Z0-9_]*)=(.*)$/))
    .filter((m) => m !== null)
    .map((m) => [m[1], m[2].trim()]),
);
const setNames = [...envFile.entries()].filter(([, v]) => v !== '').map(([k]) => k);
const appName = envFile.get('APP_NAME') || 'scaffold';
const publicHost = `${appName}.twilio.dtolb.com`;

console.log('\n\x1b[1mHOST PROCESSES\x1b[0m  \x1b[2m(pnpm dev / pnpm dev:web)\x1b[0m');

const agentHostUp = await listening(AGENT_PORT);
row(`agent  :${AGENT_PORT}`, agentHostUp, 'not running here — fine if the container is up (below)');

const webHostUp = await listening(WEB_PORT);
row(`web    :${WEB_PORT}`, webHostUp, 'not running here — fine if the container is up (below)');

const lfUp = await listening(LANGFUSE_PORT);
row(
  `langfuse:${LANGFUSE_PORT}`,
  lfUp,
  'start with:  docker compose -f docker-compose.langfuse.yml up -d',
);

if (lfUp) {
  const health = await getJson(`http://localhost:${LANGFUSE_PORT}/api/public/health`);
  console.log(`     ${D}api health: ${health ? 'ok' : 'not ready yet (ClickHouse migrations take 2-3 min on first boot)'}${X}`);
}

// ---- containers, from compose itself so this cannot drift from what is actually deployed ----
console.log(`\n\x1b[1mCONTAINERS\x1b[0m  ${D}project ${appName}${X}`);

/** compose ps emits one JSON object per line (v2), or a JSON array on some versions. */
const composePs = () => {
  try {
    const out = execFileSync('docker', ['compose', 'ps', '--all', '--format', 'json'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      // APP_NAME explicitly: docker-compose.yml's `name:` uses `${APP_NAME:?…}` and would refuse
      // to parse without it. Taken from .env, for the reason above.
      env: { ...process.env, APP_NAME: appName },
    }).toString();
    const trimmed = out.trim();
    if (trimmed === '') return [];
    if (trimmed.startsWith('[')) return JSON.parse(trimmed);
    return trimmed.split('\n').map((l) => JSON.parse(l));
  } catch {
    return null;
  }
};

const containers = composePs();
let agentContainerUp = false;

if (containers === null) {
  console.log(`  ${D}docker is not reachable (colima start), or docker-compose.yml cannot be parsed${X}`);
} else if (containers.length === 0) {
  console.log(`  ${D}none — bring the stack up with:  pnpm stack:up${X}`);
} else {
  for (const c of containers) {
    const running = c.State === 'running';
    // Health is only meaningful when a healthcheck is defined; the web service has none.
    const health = c.Health ? ` ${D}(${c.Health})${X}` : '';
    console.log(`  ${dot(running)} ${String(c.Service).padEnd(26)}${D}${c.State}${X}${health}`);
    if (c.Service === 'agent' && running) agentContainerUp = true;
  }
}

// ---- capabilities, straight from the running agent so it cannot disagree with reality ----
// Tried on the host port first (cheapest, and the dev loop), then through the public host, which
// is the only way in when the agent is containerised.
console.log('\n\x1b[1mCAPABILITIES\x1b[0m');

let health = null;
let via = '';
if (agentHostUp) {
  health = await getJson(`http://localhost:${AGENT_PORT}/health`);
  via = `host :${AGENT_PORT}`;
}
if (health === null && agentContainerUp) {
  health = await getJson(`https://${publicHost}/health`);
  via = `https://${publicHost}`;
}

if (health === null) {
  if (!agentHostUp && !agentContainerUp) {
    // `pnpm stack:up`, NOT `pnpm up` — the latter is pnpm's built-in alias for `pnpm update`. This is
    // the line a stuck user copies, so getting it wrong here costs them a rewritten lockfile.
    console.log(`  ${D}agent not running — start it with  pnpm dev  (host) or  pnpm stack:up  (container)${X}`);
  } else {
    // Genuinely worth distinguishing: the process is alive but unreachable, which on the container
    // path means the Traefik labels or the `edge` network, not the app.
    console.log(`  ${R}agent is up but /health did not answer${X}`);
    if (agentContainerUp) {
      console.log(`  ${D}container is running, so suspect routing: check the labels and`);
      console.log(`  curl -H 'Host: ${publicHost}' http://localhost/health${X}`);
    }
  }
} else {
  for (const [name, ok] of Object.entries(health.capabilities ?? {})) {
    row(name, ok, 'missing config');
  }
  if (health.missing?.length) {
    console.log(`\n  ${Y}unset:${X} ${health.missing.join(', ')}`);
  }
  console.log(`  ${D}APP_NAME=${health.appName}  via ${via}${X}`);
  if (health.appName === 'scaffold') {
    console.log(
      `  ${Y}warning${X} APP_NAME is still the default. Traefik router names are global on the`,
    );
    console.log(`          dev box, so two clones left as 'scaffold' fight over webhooks.`);
  }
  // The container reads APP_NAME from .env and compose builds the labels from the same file, so a
  // mismatch here means the running container predates the last .env edit — and `restart` does not
  // fix it, only `up -d --force-recreate` does.
  if (health.appName !== appName) {
    console.log(`  ${Y}warning${X} the agent reports APP_NAME=${health.appName} but .env says ${appName}.`);
    console.log(`          The container is running a stale env block: docker compose up -d --force-recreate`);
  }
}

// ---- config on disk, independent of whether anything is running ----
console.log('\n\x1b[1mCONFIG\x1b[0m');
if (envText === null) {
  console.log(`  ${R}○${X} .env missing            ${D}cp .env.example .env${X}`);
} else {
  console.log(`  ${G}●${X} .env present            ${D}${setNames.length} value(s) set: ${setNames.join(', ')}${X}`);
  const voiceHost = envFile.get('TWILIO_VOICE_PUBLIC_DOMAIN');
  // The T15 ordering trap, surfaced where you would actually look for it. See .env.example.
  if (voiceHost && voiceHost !== publicHost) {
    console.log(`  ${Y}!${X} TWILIO_VOICE_PUBLIC_DOMAIN is ${voiceHost},`);
    console.log(`      ${D}not ${publicHost}. Voice calls will reach that host, not this stack.${X}`);
  }
}

console.log('\n\x1b[1mURLS\x1b[0m');
console.log(`  ${D}public    ${X}https://${publicHost}${D}          (web, and /api /events /health on the agent)${X}`);
console.log(`  ${D}health    ${X}https://${publicHost}/health`);
console.log(`  ${D}dev web   ${X}http://localhost:${WEB_PORT}`);
// `dev api` rather than `dev health`: every label in this block is hand-padded to 10 columns, and
// `dev health` fills the field exactly, so it printed flush against its URL. Shortened rather than
// widened, so the URLs stay in the one column the other four already share.
console.log(`  ${D}dev api   ${X}http://localhost:${AGENT_PORT}/health`);
console.log(`  ${D}langfuse  ${X}http://localhost:${LANGFUSE_PORT}`);
console.log(`\n${D}build progress: docs/HANDOFF.md${X}`);
console.log(`${D}checks:         pnpm typecheck && pnpm test${X}\n`);
