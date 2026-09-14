/**
 * Push the authored Northwind Traders articles into a Twilio Enterprise Knowledge base.
 *
 *   pnpm seed:knowledge
 *
 * Companion to `pnpm seed:prompts`: the repo owns the content, the account owns the index. Running
 * this on a fresh clone is the whole reason `scripts/knowledge-articles.ts` exists in the repo — a
 * knowledge base that only lives in one Twilio account cannot be handed to anybody.
 *
 * ── Two paths ───────────────────────────────────────────────────────────────────────────────────
 *
 * `TWILIO_KNOWLEDGE_BASE_ID` set   → seed into that base.
 * `TWILIO_KNOWLEDGE_BASE_ID` unset → CREATE a base, then seed it, then print the id to paste into
 *                                    `.env`. The script cannot write `.env` for you and should not:
 *                                    that file holds live credentials and is gitignored.
 *
 * ── Idempotent by SKIPPING, deliberately ────────────────────────────────────────────────────────
 *
 * An article whose `name` already exists in the base is left completely alone. It is not patched and
 * not replaced. Re-running is therefore free, and a run can never quietly overwrite content someone
 * edited in the Console — which is the same reasoning `seed-prompts.ts` applies to Langfuse versions,
 * where an operator edit is treated as real. To ship a change to an existing article, delete that
 * source in the Console (or with `DELETE .../Knowledge/{id}`) and re-run.
 *
 * ── What was measured, 2026-09-14 ───────────────────────────────────────────────────────────────
 *
 * - Creating a knowledge base returns **202** with a `statusUrl`, not the resource. Poll it: the
 *   operation body carries `result.id`, which is the `know_knowledgebase_*` id. It completed inside
 *   the first poll on this account.
 * - Creating a knowledge SOURCE returns **201** immediately with `status: "QUEUED"`, then goes
 *   PROCESSING and then COMPLETED. A source that is not COMPLETED is not searchable yet, so this
 *   waits rather than reporting success it has not seen. All five reached COMPLETED in well under a
 *   minute.
 * - The host is `knowledge.twilio.com` for BOTH the control plane and the data plane. It is not
 *   `conversations.twilio.com`, which is where the Conversation Orchestrator configurations live.
 *
 * `scripts/` is exempt from the no-console rule. It is not exempt from being honest: every failure
 * here sets a non-zero exit code, because a seeder that half-works and says nothing is worse than
 * one that stops.
 */
import { KNOWLEDGE_ARTICLES } from './knowledge-articles.ts';
import { loadConfig } from '../server/config.ts';

const KNOWLEDGE_BASE = 'https://knowledge.twilio.com/v2';

/**
 * The base's addressable name. `^[a-zA-Z0-9-]+$` is enforced by the API — no spaces, no
 * underscores — and it must be unique within the account, so a second clone sharing one account
 * gets a conflict here rather than a silent second base with identical content.
 */
const DISPLAY_NAME = 'northwind-traders-support';

const app = loadConfig(process.env);
if (app.twilio === null) {
  console.error('seed:knowledge needs Twilio credentials. Missing or malformed:');
  for (const m of app.missing.filter((v) => v.feature === 'Twilio')) {
    console.error(`  ${m.name} — ${m.breaks}`);
  }
  console.error('\nTWILIO_ACCOUNT_SID / TWILIO_API_KEY / TWILIO_API_SECRET, in .env or the shell.');
  process.exit(1);
}

const auth = `Basic ${Buffer.from(`${app.twilio.apiKey}:${app.twilio.apiSecret}`).toString('base64')}`;

interface Res {
  readonly status: number;
  readonly body: unknown;
}

const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
  const res = await fetch(`${KNOWLEDGE_BASE}${path}`, {
    method,
    headers: {
      authorization: auth,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
};

/**
 * The type annotation is on the VARIABLE, not just on the arrow's return. TypeScript only treats a
 * call as unreachable-terminating — which is what lets `if (x === undefined) die(...)` narrow `x`
 * afterwards — when the declaration itself is annotated. Annotating only `(): never =>` compiles but
 * narrows nothing, and every call site then needs an `as string` that hides a real question.
 */
const die: (msg: string, res?: Res) => never = (msg, res) => {
  console.error(`\nFAILED: ${msg}`);
  if (res !== undefined) console.error(`  HTTP ${res.status} ${JSON.stringify(res.body)}`);
  process.exit(1);
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Poll an async control-plane operation to a terminal state.
 *
 * Every create on this control plane is asynchronous, and the 202 is NOT a failure — treating it as
 * one is the easy mistake, because the response carries no resource at all.
 */
const awaitOperation = async (statusUrl: string): Promise<string> => {
  const path = statusUrl.replace(KNOWLEDGE_BASE, '');
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const res = await call('GET', path);
    const op = res.body as {
      status?: string;
      error?: unknown;
      result?: { id?: string };
    } | null;
    const status = op?.status ?? `HTTP ${res.status}`;
    if (status === 'COMPLETED') {
      const id = op?.result?.id;
      if (typeof id !== 'string') die('operation COMPLETED but carried no result.id', res);
      return id;
    }
    if (status === 'FAILED') die(`operation FAILED: ${JSON.stringify(op?.error)}`, res);
    process.stdout.write(`    ${status} (${attempt})\r`);
    await sleep(2000);
  }
  return die('operation never reached COMPLETED after 60s');
};

// ---- the base: reuse the configured one, or create one ----

let kbId = app.knowledgeBaseId;
let created = false;

if (kbId === null) {
  console.log(`no TWILIO_KNOWLEDGE_BASE_ID set — creating a base named "${DISPLAY_NAME}"`);
  const res = await call('POST', '/ControlPlane/KnowledgeBases', {
    displayName: DISPLAY_NAME,
    description:
      'Northwind Traders support policies for the demo scaffold: returns, shipping, warranty, claims, price match',
  });
  if (res.status !== 202) {
    die('could not create the knowledge base (a duplicate displayName is the likely cause — reuse the existing id instead)', res);
  }
  const statusUrl = (res.body as { statusUrl?: string }).statusUrl;
  if (typeof statusUrl !== 'string') die('create returned 202 with no statusUrl to poll', res);
  kbId = await awaitOperation(statusUrl);
  created = true;
  console.log(`  created ${kbId}`);
} else {
  console.log(`using TWILIO_KNOWLEDGE_BASE_ID=${kbId}`);
}

const base = await call('GET', `/ControlPlane/KnowledgeBases/${kbId}`);
if (base.status !== 200) die('the knowledge base id does not resolve', base);
const meta = base.body as { displayName?: string; status?: string };
console.log(`  displayName=${meta.displayName} status=${meta.status}`);

// ---- the articles ----

const existing = await call('GET', `/KnowledgeBases/${kbId}/Knowledge?pageSize=100`);
if (existing.status !== 200) die('could not list the existing knowledge sources', existing);
const present = new Set(
  ((existing.body as { knowledge?: { name?: string }[] }).knowledge ?? [])
    .map((k) => k.name)
    .filter((n): n is string => typeof n === 'string'),
);

console.log(`\n${KNOWLEDGE_ARTICLES.length} article(s) to seed; ${present.size} already in the base`);

const pushed: string[] = [];
const skipped: string[] = [];

for (const article of KNOWLEDGE_ARTICLES) {
  if (present.has(article.name)) {
    skipped.push(article.name);
    console.log(`  skip   ${article.name} (already present — delete it in the Console to re-push)`);
    continue;
  }

  // The name/description caps are enforced by the API as a 400. Checked here so the failure names
  // the article rather than arriving as an opaque validation error halfway through a run.
  if (article.name.length > 30) die(`article name ${JSON.stringify(article.name)} exceeds 30 chars`);
  if (article.description.length > 1024) die(`description for ${article.name} exceeds 1024 chars`);

  const res = await call('POST', `/KnowledgeBases/${kbId}/Knowledge`, {
    name: article.name,
    description: article.description,
    // Capitalised "Text" — see the note in knowledge-articles.ts. Lowercase is what the prose docs
    // show and is not what the API accepted.
    source: { type: 'Text', content: article.content },
  });
  if (res.status !== 201) die(`could not create source ${article.name}`, res);
  const id = (res.body as { id?: string }).id;
  if (typeof id !== 'string') die(`source ${article.name} came back with no id`, res);
  pushed.push(id);
  console.log(`  push   ${article.name} -> ${id} (${article.content.length} chars)`);
}

// ---- wait for indexing, because QUEUED is not searchable ----

if (pushed.length > 0) {
  console.log('\nwaiting for indexing (a source is not searchable until COMPLETED)');
  const waiting = new Set(pushed);
  for (let attempt = 1; attempt <= 45 && waiting.size > 0; attempt += 1) {
    await sleep(2000);
    for (const id of [...waiting]) {
      const res = await call('GET', `/KnowledgeBases/${kbId}/Knowledge/${id}`);
      const status = (res.body as { status?: string; name?: string } | null)?.status ?? `HTTP ${res.status}`;
      if (status === 'COMPLETED') {
        waiting.delete(id);
        console.log(`  ready  ${(res.body as { name?: string }).name}`);
      } else if (status === 'FAILED') {
        waiting.delete(id);
        console.error(`  FAILED ${(res.body as { name?: string }).name} — the source will not be searchable`);
        process.exitCode = 1;
      }
    }
  }
  if (waiting.size > 0) {
    console.error(`  ${waiting.size} source(s) still not COMPLETED after 90s — re-run verify:knowledge later`);
    process.exitCode = 1;
  }
}

console.log(
  `\n${pushed.length} pushed, ${skipped.length} skipped. Prove it with:\n` +
    '  node --env-file-if-exists=.env scripts/verify-knowledge.ts',
);
if (created) {
  console.log(
    `\nADD THIS TO .env (it is gitignored, and nothing else can supply it — the Conversation\n` +
      `Orchestrator configuration carries no knowledge base id, so this is its own variable):\n` +
      `  TWILIO_KNOWLEDGE_BASE_ID=${kbId}`,
  );
}
