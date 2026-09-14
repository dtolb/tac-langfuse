/**
 * Publish the committed handoff flow over the Studio flow named by `TWILIO_STUDIO_HANDOFF_FLOW_SID`.
 *
 *   pnpm seed:studio            # dry run: fetch, back up, print the diff, change nothing
 *   pnpm seed:studio --write    # publish
 *
 * Companion to `pnpm seed:prompts` and `pnpm seed:knowledge`: the repo owns the content, the account
 * owns the live resource.
 *
 * ── THE BACKUP IS NOT OPTIONAL, AND IT IS RE-READ ───────────────────────────────────────────────
 *
 * A flow update is a FULL REPLACE of `Definition`. So this GETs the current flow, writes it to
 * `.superpowers/t14b/` as `JSON.stringify(parsed, null, 2)` — a re-serialisation rather than the bytes
 * Twilio sent, so whitespace and key order may differ from the wire; recovery is unaffected because it
 * PUTs the parsed `definition` back — re-reads that file and checks it parses and still carries a
 * `definition` with a `states` array, and only then PUTs. A truncated backup is worse than none, because it reads as
 * recoverable right up until it is needed — which is why the re-read exists rather than trusting the
 * write. Recovery is PUTting the saved `definition` back unchanged.
 *
 * Twilio also retains the prior REVISION server-side (`GET /v2/Flows/{sid}/Revisions`), so there are two
 * independent ways back. The local copy is the one that survives losing account access.
 *
 * DRY RUN BY DEFAULT. `--write` is the same gate `repoint-public-host.ts` uses, for the same reason:
 * this mutates a live account resource, and the default behaviour of a script somebody is running for
 * the first time should be to show them what it would do.
 *
 * `scripts/` is exempt from the no-console rule and from the vendor boundary. It is not exempt from
 * exiting non-zero when it fails.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadConfig } from '../server/config.ts';
import { CLIENT_IDENTITY } from '../shared/handoff.ts';
import { STUDIO_FLOW_FRIENDLY_NAME, STUDIO_HANDOFF_FLOW_DEFINITION } from './studio-handoff-flow.ts';

const STUDIO_BASE = 'https://studio.twilio.com/v2';
const BACKUP_DIR = '.superpowers/t14b';

const app = loadConfig(process.env);
if (app.twilio === null) {
  console.error('seed:studio needs Twilio credentials. Missing or malformed:');
  for (const m of app.missing.filter((v) => v.feature === 'Twilio')) {
    console.error(`  ${m.name} — ${m.breaks}`);
  }
  process.exit(1);
}
if (app.studioHandoffFlowSid === null) {
  // Deliberately does NOT create a flow. Creating one would hand back a SID that has to be pasted into
  // `.env` anyway, and this script's whole value is that the flow it publishes is reviewable in git —
  // which a freshly created empty flow is not. Point it at a flow that exists.
  console.error(
    'seed:studio needs TWILIO_STUDIO_HANDOFF_FLOW_SID (FW + 32 LOWERCASE hex chars) in .env.\n' +
      'Create an empty flow in the Studio console, paste its SID, then re-run.',
  );
  process.exit(1);
}

const write = process.argv.includes('--write');
const flowSid = app.studioHandoffFlowSid;
const auth = `Basic ${Buffer.from(`${app.twilio.apiKey}:${app.twilio.apiSecret}`).toString('base64')}`;

interface Res {
  readonly status: number;
  readonly body: unknown;
}

const call = async (method: string, path: string, form?: URLSearchParams): Promise<Res> => {
  const res = await fetch(`${STUDIO_BASE}${path}`, {
    method,
    headers: {
      authorization: auth,
      ...(form === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }),
    },
    ...(form === undefined ? {} : { body: form.toString() }),
  });
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
};

/** Annotated on the VARIABLE so TypeScript treats a call as terminating and narrows afterwards. */
const die: (msg: string, res?: Res) => never = (msg, res) => {
  console.error(`\nFAILED: ${msg}`);
  if (res !== undefined) console.error(`  HTTP ${res.status}: ${JSON.stringify(res.body).slice(0, 800)}`);
  process.exit(1);
};

// ---- 1. fetch the live flow ----

const current = await call('GET', `/Flows/${flowSid}`);
if (current.status !== 200) die(`could not read flow ${flowSid}`, current);
const live = current.body as { friendly_name?: string; status?: string; revision?: number; definition?: { states?: unknown[] } };
console.log(`live: ${live.friendly_name ?? '?'} status=${live.status ?? '?'} revision=${live.revision ?? '?'}`);
console.log(`      ${live.definition?.states?.length ?? 0} state(s)`);

// ---- 2. back it up, then RE-READ it ----

mkdirSync(BACKUP_DIR, { recursive: true });
const backupPath = `${BACKUP_DIR}/flow-${flowSid}-revision-${live.revision ?? 'unknown'}.json`;
writeFileSync(backupPath, JSON.stringify(current.body, null, 2));

const reread = JSON.parse(readFileSync(backupPath, 'utf8')) as typeof live;
if (!Array.isArray(reread.definition?.states)) {
  die(`the backup at ${backupPath} does not carry definition.states — refusing to publish over the live flow`);
}
console.log(`backup: ${backupPath} (re-read, ${reread.definition.states.length} state(s))`);

// ---- 3. show what changes ----

const nextStates = STUDIO_HANDOFF_FLOW_DEFINITION.states.map((s) => `${s.name} (${s.type})`);
console.log(`\nwould publish ${nextStates.length} state(s): ${nextStates.join(', ')}`);
console.log(`  dialling client:${CLIENT_IDENTITY} — note NO HYPHEN, which is the Voice SDK identity rule`);

if (!write) {
  console.log('\nDRY RUN. Nothing was changed. Re-run with --write to publish.');
  process.exit(0);
}

// ---- 4. publish ----

const form = new URLSearchParams();
form.append('FriendlyName', STUDIO_FLOW_FRIENDLY_NAME);
// `published`, not `draft`: a draft flow is not reachable by the webhook URL our action route redirects
// to, so publishing a draft would look exactly like a broken redirect.
form.append('Status', 'published');
form.append('Definition', JSON.stringify(STUDIO_HANDOFF_FLOW_DEFINITION));
form.append('CommitMessage', 'demo-scaffold T14b: dial the browser softphone');

const put = await call('POST', `/Flows/${flowSid}`, form);
if (put.status !== 200) die('the flow update was rejected', put);
const updated = put.body as { revision?: number; status?: string };
console.log(`\npublished: revision ${updated.revision ?? '?'} status=${updated.status ?? '?'}`);

// ---- 5. re-read and confirm what landed ----

const after = await call('GET', `/Flows/${flowSid}`);
if (after.status !== 200) die('could not re-read the flow after publishing', after);
const landed = (after.body as { definition?: { states?: { name?: string; properties?: { to?: string } }[] } }).definition;
const connect = landed?.states?.find((s) => s.name === 'connect_to_softphone');
if (connect?.properties?.to !== CLIENT_IDENTITY) {
  die(`the published flow dials ${String(connect?.properties?.to)} rather than ${CLIENT_IDENTITY}`);
}
console.log(`confirmed: connect_to_softphone dials client:${CLIENT_IDENTITY}`);
console.log(`\nrecovery: PUT the "definition" from ${backupPath} back, or restore the prior revision.`);
