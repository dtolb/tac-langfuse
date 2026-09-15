// Refuses to bring the stack up on a misconfiguration that Docker, Traefik and the app would all
// accept in silence.
//
//   pnpm preflight
//   node --env-file-if-exists=.env scripts/preflight.mjs
//
// ⚠ THE --env-file FLAG IS PART OF THE COMMAND, not decoration. A bare `node scripts/preflight.mjs`
// does not parse .env, so process.env.APP_NAME reads as `undefined` rather than `'scaffold'` — and a
// naive "is it the default?" check would then PASS VACUOUSLY on exactly the machine this file exists
// to protect. The `.env` is on disk but its APP_NAME was never loaded check below exists to catch
// that specific mistake rather than trusting the invocation.
//
// Promised at .env.example:30 since T1 and written at T15, when the Traefik router names it warns
// about became real.
//
// Read-only: starts nothing, changes nothing.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const G = '\x1b[32m';
const R = '\x1b[31m';
const Y = '\x1b[33m';
const D = '\x1b[2m';
const X = '\x1b[0m';

let failures = 0;
let warnings = 0;

const ok = (msg, detail = '') => console.log(`  ${G}●${X} ${msg}${detail ? `  ${D}${detail}${X}` : ''}`);
const fail = (msg, fix) => {
  failures += 1;
  console.log(`  ${R}○${X} ${msg}`);
  if (fix) console.log(`      ${D}${fix}${X}`);
};
const warn = (msg, fix) => {
  warnings += 1;
  console.log(`  ${Y}!${X} ${msg}`);
  if (fix) console.log(`      ${D}${fix}${X}`);
};

console.log('\n\x1b[1mPREFLIGHT\x1b[0m');

// ---------------------------------------------------------------------------- was .env loaded?
// Ordered first because every check below is meaningless if the answer is no.
const appName = process.env.APP_NAME;
const envOnDisk = existsSync('.env');
const envDeclaresAppName = envOnDisk && /^APP_NAME=/m.test(readFileSync('.env', 'utf8'));

if (envDeclaresAppName && appName === undefined) {
  fail(
    '.env declares APP_NAME but this process cannot see it — .env was never parsed',
    'run it as: node --env-file-if-exists=.env scripts/preflight.mjs   (or: pnpm preflight)',
  );
} else if (!envOnDisk) {
  fail('.env does not exist', 'cp .env.example .env, then set APP_NAME');
}

// ---------------------------------------------------------------------------- APP_NAME
// server/config.ts falls back to 'scaffold' and applies NO format validation at all, so this is the
// only place a malformed value is ever rejected. An APP_NAME with a space compiles, boots, warns
// nothing, and produces a Traefik rule that silently never matches.
const DNS_SAFE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

if (appName === undefined || appName.trim() === '') {
  fail('APP_NAME is unset', 'set APP_NAME in .env — it names the container, the routers and the public host');
} else if (appName.trim() === 'scaffold') {
  fail(
    "APP_NAME is still the default 'scaffold'",
    'Traefik router names are GLOBAL on the dev box, so two clones left at the default define the\n' +
      '      same routers and one demo silently steals the other’s Twilio webhooks. Nothing errors.',
  );
} else if (!DNS_SAFE.test(appName.trim())) {
  fail(
    `APP_NAME ${JSON.stringify(appName)} is not DNS-safe`,
    'lowercase letters, digits and dashes only, no leading or trailing dash. It becomes a hostname\n' +
      '      label in https://<APP_NAME>.twilio.dtolb.com and a Traefik rule; a space or capital there\n' +
      '      produces a router that never matches, with no error anywhere.',
  );
} else {
  ok(`APP_NAME=${appName.trim()}`, `https://${appName.trim()}.twilio.dtolb.com`);
}

// ---------------------------------------------------------------------------- the edge network
// Compose would otherwise create ${APP_NAME}_edge, Traefik would find no container IP on `edge`, and
// would drop the service with no error on either side.
let dockerReachable = true;
try {
  execFileSync('docker', ['network', 'inspect', 'edge'], { stdio: 'pipe' });
  ok('docker network `edge` exists');
} catch (err) {
  // Distinguish "no docker" from "no edge" — the fixes are completely different.
  try {
    execFileSync('docker', ['info'], { stdio: 'pipe' });
    fail(
      'docker network `edge` does not exist',
      'the Traefik dev box owns it. Start that stack first, or: docker network create edge',
    );
  } catch {
    dockerReachable = false;
    fail(`docker is not reachable (${err.code ?? 'error'})`, 'colima start');
  }
}

// ---------------------------------------------------------------------------- Traefik itself
// Not required for `up` to succeed, which is the point: the stack comes up perfectly and every URL
// 404s, which reads as a routing bug in these labels rather than an absent proxy.
if (dockerReachable) {
  try {
    const state = execFileSync('docker', ['inspect', '-f', '{{.State.Running}}', 'traefik'], {
      stdio: 'pipe',
    })
      .toString()
      .trim();
    if (state === 'true') ok('traefik is running');
    else warn('the traefik container exists but is not running', 'nothing will route until it is up');
  } catch {
    warn('no container named `traefik` on this machine', 'nothing will route; the dev box provides it');
  }
}

// ---------------------------------------------------------------------------- CORP_CA_PATH
// A path that does not exist is FATAL AT CONTAINER CREATE (`invalid mount config`), not at build, so
// it fails after a successful image build with an error that names Docker rather than this variable.
const caPath = process.env.CORP_CA_PATH;
if (caPath === undefined || caPath.trim() === '') {
  // docker-compose.yml defaults the secret to /dev/null precisely so this case works.
  warn(
    'CORP_CA_PATH is unset — the corp CA secret falls back to /dev/null',
    'correct off the VPN. On it, TLS fails during `pnpm install` in the build:\n' +
      '      CORP_CA_PATH="$HOME/.config/zscaler-root.crt" docker compose up -d --build   (pnpm stack:up does this)',
  );
} else if (!existsSync(caPath)) {
  fail(
    `CORP_CA_PATH=${caPath} does not exist`,
    'a missing path is fatal when the container is CREATED, after the build succeeds.\n' +
      '      Off the VPN, set CORP_CA_PATH=/dev/null rather than leaving it pointing at nothing.',
  );
} else if (caPath !== '/dev/null' && statSync(caPath).size === 0) {
  warn(`CORP_CA_PATH=${caPath} is empty`, 'Node will warn "Ignoring extra certs" and fall back to the system bundle');
} else {
  ok(`CORP_CA_PATH=${caPath}`);
}

// ---------------------------------------------------------------------------- the public host
// THE ORDERING TRAP, and the most demo-destroying failure available here.
//
// TWILIO_VOICE_PUBLIC_DOMAIN builds BOTH wss://<host>/ws and the <Connect action> URL
// (server/twilio/voice.ts). Bring the stack up before repointing it and everything looks right —
// the container is healthy, /health says voice: ready, Traefik routes perfectly — while every
// inbound call connects to the old host and sits in SILENCE with nothing in the container logs,
// because the WebSocket never arrives.
//
// A WARNING, NOT A FAILURE: an ngrok host here is a legitimate choice, and refusing to start on it
// would be policing a decision rather than reporting a hazard.
const voiceHost = process.env.TWILIO_VOICE_PUBLIC_DOMAIN;
const expectedHost = appName && DNS_SAFE.test(appName.trim()) ? `${appName.trim()}.twilio.dtolb.com` : null;

if (voiceHost === undefined || voiceHost.trim() === '') {
  warn('TWILIO_VOICE_PUBLIC_DOMAIN is unset', 'voice cannot register at all — TACServer throws at construction');
} else if (expectedHost !== null && voiceHost.trim() !== expectedHost) {
  warn(
    `TWILIO_VOICE_PUBLIC_DOMAIN is ${voiceHost.trim()}, not ${expectedHost}`,
    'if you meant to route voice through Traefik, REPOINT BEFORE bringing the stack up:\n' +
      `      node --env-file-if-exists=.env scripts/repoint-public-host.ts ${expectedHost} --write\n` +
      '      Backwards, the container boots green and every call sits in silence with empty logs.',
  );
} else if (expectedHost !== null) {
  ok(`TWILIO_VOICE_PUBLIC_DOMAIN=${voiceHost.trim()}`, 'matches the Traefik host');
}

// ---------------------------------------------------------------------------- verdict
console.log('');
if (failures > 0) {
  console.log(`${R}${failures} check(s) FAILED${X}${warnings ? `, ${warnings} warning(s)` : ''} — refusing to bring the stack up\n`);
  process.exitCode = 1;
} else {
  console.log(`${G}preflight OK${X}${warnings ? ` ${D}(${warnings} warning(s) above — read them)${X}` : ''}\n`);
}
