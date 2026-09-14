/**
 * Diagnostic: does the knowledge base actually answer the questions the demo tools cannot?
 *
 *   node --env-file-if-exists=.env scripts/verify-knowledge.ts
 *
 * READ-ONLY and free. Knowledge search is not billed traffic, so unlike the SMS and voice proofs
 * this one can be run as often as you like — which is the point: it is the fast check to run before
 * spending anything.
 *
 * It exists because "the knowledge base is wired" and "the knowledge base is useful" are different
 * claims and only the second one matters. `capabilities().knowledge` goes true the moment
 * `TWILIO_KNOWLEDGE_BASE_ID` is a non-empty string — it does not know whether the base has any
 * sources, whether they finished indexing, or whether they contain anything relevant. A base with
 * five QUEUED sources reports `knowledge: true` and returns nothing.
 *
 * So this checks four things in order, and every surprise sets a non-zero exit code the way the other
 * `verify-*` scripts do:
 *
 *   1. the capability flag, and the id it came from
 *   2. the base resolves and is ACTIVE
 *   3. every seeded article is present and COMPLETED
 *   4. five real customer questions retrieve the article that should answer them
 *
 * ── What the scores mean, measured 2026-09-14 ───────────────────────────────────────────────────
 *
 * **`score` is not comparable across queries.** The top hit is frequently exactly `1.0000`, and the
 * value `0.8000` recurs exactly across unrelated queries, so the number behaves like a per-query
 * rescaling and not like an absolute similarity. That rules out the check this script was originally
 * going to make — "an out-of-scope question scores lower than an in-scope one". Measured
 * counter-example: `What time does the Downtown store close on Sunday?` returns
 * `price-match-guarantee` at **0.8000**, higher than several genuinely correct answers score.
 *
 * A chunk also carries four fields the API reference does not list — `chunkIndex`, `documentNumber`,
 * `documentTitle`, `documentUrl` (the last three `null` for a Text source). TAC's
 * `KnowledgeChunkResultSchema` is a stripping object over `content`/`knowledgeId`/`createdAt`/`score`,
 * so the extras are discarded rather than rejected. Nothing to do about it; worth knowing before
 * anyone writes a mirror of that schema.
 *
 * The consequence is worth stating plainly, because it shapes the demo: **semantic search always
 * returns something, confidently.** Nothing here can be used as a "the knowledge base does not know
 * this" gate. Keeping store hours and order status OUT of the content is therefore not a nicety, it
 * is the only mechanism that stops the knowledge base from answering questions that belong to
 * `lookup_order` and `get_store_hours` — the tool descriptions do the rest.
 *
 * **Rank 1 is not guaranteed, rank-in-top-3 is.** A query that names a product pulls
 * `warranty-terms` up, because that article is the one that lists every product by name. Measured:
 * `How long do I have to send back a desk lamp I decided I do not want?` ranks `warranty-terms`
 * first and `returns-and-exchanges` second. The model receives all the chunks, so that is a
 * non-problem — but it is why the assertion below is "in the top 3" rather than "first", and why the
 * probe queries are phrased the way a customer phrases them rather than tuned until they pass.
 */
import { KNOWLEDGE_ARTICLES } from './knowledge-articles.ts';
import { capabilities, loadConfig } from '../server/config.ts';

const KNOWLEDGE_BASE = 'https://knowledge.twilio.com/v2';
const TOP = 3;

/**
 * The probes. Each is a question NEITHER demo tool can answer, paired with the article that should
 * answer it. Phrased as a customer would phrase it — see the header on why they are not tuned.
 */
const PROBES: readonly { readonly query: string; readonly expect: string }[] = [
  { query: 'What is your return policy and how long does a refund take?', expect: 'returns-and-exchanges' },
  { query: 'How much does overnight shipping cost?', expect: 'shipping-times-and-costs' },
  { query: 'The gas spring on my monitor arm went floppy. Is that covered?', expect: 'warranty-terms' },
  { query: 'Someone marked my package delivered but it is not here.', expect: 'damaged-missing-claims' },
  { query: 'Will you match a lower price I found somewhere else?', expect: 'price-match-guarantee' },
];

let failures = 0;
const fail = (msg: string): void => {
  failures += 1;
  console.log(`  FAIL  ${msg}`);
};

const app = loadConfig(process.env);
const caps = capabilities(app);

console.log('knowledge wiring\n');
console.log(`  capabilities: knowledge=${caps.knowledge} sms=${caps.sms} memory=${caps.memory}`);
console.log(`  knowledgeBaseId: ${app.knowledgeBaseId ?? '(unset)'}`);

if (app.twilio === null) {
  fail('no Twilio credentials — set TWILIO_ACCOUNT_SID / TWILIO_API_KEY / TWILIO_API_SECRET');
} else if (app.knowledgeBaseId === null) {
  // Not a code problem and not a crash: `search_knowledge` is simply absent, by design. But this
  // script was run deliberately, so say what to do about it.
  fail(
    'TWILIO_KNOWLEDGE_BASE_ID is unset, so capabilities().knowledge is false and search_knowledge ' +
      'is not in the catalog — run `pnpm seed:knowledge` and put the id it prints into .env',
  );
} else if (!caps.knowledge) {
  // The id is present but the capability is still false, which can only mean orchestrated mode is
  // off — `knowledge` is derived from BOTH, because TAC reaches Knowledge through the same client it
  // builds from the Conversation Orchestrator configuration.
  fail(
    'a knowledge base id is set but capabilities().knowledge is false — TWILIO_CONVERSATION_' +
      'CONFIGURATION_ID is missing or malformed, and Knowledge is unreachable without orchestrated mode',
  );
} else {
  const auth = `Basic ${Buffer.from(`${app.twilio.apiKey}:${app.twilio.apiSecret}`).toString('base64')}`;
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> => {
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

  const kbId = app.knowledgeBaseId;

  // ---- the base ----
  const base = await call('GET', `/ControlPlane/KnowledgeBases/${kbId}`);
  if (base.status !== 200) {
    fail(`GET the knowledge base returned ${base.status} — the id does not resolve on this account`);
  } else {
    const meta = base.body as { displayName?: string; status?: string; version?: number };
    console.log(`  base: ${meta.displayName} status=${meta.status} version=${meta.version}`);
    if (meta.status !== 'ACTIVE') {
      fail(`the base is ${meta.status}, not ACTIVE — search will return nothing until it is`);
    }
  }

  // ---- the sources ----
  const list = await call('GET', `/KnowledgeBases/${kbId}/Knowledge?pageSize=100`);
  const byId = new Map<string, string>();
  if (list.status !== 200) {
    fail(`listing knowledge sources returned ${list.status}`);
  } else {
    const sources = ((list.body as { knowledge?: unknown }).knowledge ?? []) as {
      id?: string;
      name?: string;
      status?: string;
      source?: { content?: string };
    }[];
    console.log(`\n  ${sources.length} source(s):`);
    for (const s of sources) {
      if (typeof s.id === 'string' && typeof s.name === 'string') byId.set(s.id, s.name);
      const chars = s.source?.content?.length ?? 0;
      console.log(`    ${s.name} — ${s.status}${chars > 0 ? `, ${chars} chars` : ''}`);
      // A source stuck short of COMPLETED is invisible to search while looking configured.
      if (s.status !== 'COMPLETED') {
        fail(`source ${s.name} is ${s.status}, not COMPLETED — it is not searchable`);
      }
    }

    const seeded = new Set(sources.map((s) => s.name));
    const absent = KNOWLEDGE_ARTICLES.filter((a) => !seeded.has(a.name)).map((a) => a.name);
    if (absent.length > 0) {
      fail(`the repo authors ${absent.join(', ')} but the base does not have them — run \`pnpm seed:knowledge\``);
    }
  }

  // ---- the only question that matters: does a real query retrieve the right article? ----
  console.log(`\n  ${PROBES.length} probe queries (top ${TOP}, expecting the right article in range):`);
  for (const probe of PROBES) {
    const res = await call('POST', `/KnowledgeBases/${kbId}/Search`, { query: probe.query, top: TOP });
    if (res.status !== 200) {
      fail(`search returned ${res.status} for ${JSON.stringify(probe.query)}`);
      continue;
    }
    const chunks = ((res.body as { chunks?: unknown }).chunks ?? []) as {
      content?: string;
      knowledgeId?: string;
      score?: number;
    }[];

    console.log(`\n    Q  ${probe.query}`);
    if (chunks.length === 0) {
      fail(`no chunks at all for ${JSON.stringify(probe.query)} — the base is empty or unindexed`);
      continue;
    }

    const ranked = chunks.map((c) => byId.get(c.knowledgeId ?? '') ?? (c.knowledgeId ?? '?'));
    for (const [i, c] of chunks.entries()) {
      const first = (c.content ?? '').replace(/\s+/g, ' ').slice(0, 96);
      console.log(`    ${i + 1}. ${(c.score ?? 0).toFixed(4)}  ${ranked[i]}`);
      console.log(`       ${first}…`);
    }

    const at = ranked.indexOf(probe.expect);
    if (at === -1) {
      fail(
        `${JSON.stringify(probe.query)} did not retrieve ${probe.expect} in the top ${TOP} — got ` +
          `${ranked.join(', ')}. The content has drifted away from the question.`,
      );
    } else if (at > 0) {
      // A note, not a failure. See the header: a product-naming query legitimately pulls
      // warranty-terms up, and the model sees every chunk anyway.
      console.log(`       note: ${probe.expect} is rank ${at + 1}, not 1 — still in range`);
    }
  }

  console.log(
    failures === 0
      ? '\nall checks passed'
      : `\n${failures} check(s) FAILED — see the FAIL lines above (exit 1)`,
  );
}

if (failures > 0) process.exitCode = 1;
