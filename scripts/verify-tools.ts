/**
 * Diagnostic: prove the tool catalog resolves what LIVE Langfuse is serving right now, and exit
 * NON-ZERO if it does not.
 *
 *   node --env-file-if-exists=.env scripts/verify-tools.ts
 *
 * The failure being guarded against is silent: a prompt version edited in Langfuse can name
 * anything at all, and the wrong answer — a thrown error, or a turn that quietly offers no tools
 * with nothing anywhere saying so — looks exactly like a working demo until someone reads a
 * transcript. So it is observed rather than reasoned about, the same reason verify-prompts.ts and
 * verify-telemetry.ts exist.
 *
 * It CHECKS rather than merely prints. Every surprise sets `process.exitCode = 1`, so this is usable
 * as a smoke check whose exit code means something (T11 wants exactly that). What it deliberately
 * does NOT do is restate the unit tests: the three-way partition, dedup, the never-throws contract
 * and both tool bodies are pinned in `tests/tools.test.ts`, where they run on every commit without a
 * network. A shorter script that can fail beats a longer one that cannot.
 *
 * Measured on the first run, against Langfuse still holding the pre-T8 seed (v1, naming the two TAC
 * built-ins that do not exist until T14): both names landed in `unknown`, ONE WARN line named both,
 * the `tool.selection` event read `0 of 2 tools resolved — unknown: search_knowledge, send_message`,
 * and nothing threw. After `pnpm seed:prompts` pushed the updated defaults as v2, the same fetch
 * read `2 of 2 tools resolved`. That pair is the point: the second run is the happy path, and the
 * first is what a stale prompt version does to a live call — degraded, loudly, and still answering.
 * A forced mixed case measured `2 of 4 tools resolved — unknown: no_such_tool — unavailable:
 * search_knowledge`; that partition is now pinned in the unit tests rather than re-observed here.
 *
 * Reading the output: pino batches its writes to stdout while `console.log` is synchronous, so the
 * WARN and DEBUG lines can land AFTER the block they belong to. They are not missing.
 */
import { capabilities, loadConfig } from '../server/config.ts';
import { CHANNEL_PROMPT } from '../server/agent/prompt/defaults.ts';
import { createLangfusePromptPort } from '../server/agent/prompt/langfuse.ts';
import { promptCacheTtlMs } from '../server/agent/prompt/port.ts';
import { createObsBus } from '../server/obs/bus.ts';
import { toolCatalog } from '../server/agent/tools/catalog.ts';
import { toJsonSchema } from '../server/agent/tools/registry.ts';
import { preflightDefaultPromptTools, resolve } from '../server/agent/tools/resolve.ts';

/**
 * Records a surprise and keeps going: one run reports every problem rather than the first, and the
 * exit code is set the moment anything is wrong.
 */
let failures = 0;
const fail = (msg: string): void => {
  failures += 1;
  process.exitCode = 1;
  console.error(`  FAIL  ${msg}`);
};

const app = loadConfig(process.env);
const caps = capabilities(app);
console.log(`langfuse config: ${app.langfuse === null ? 'ABSENT' : app.langfuse.baseUrl}`);
console.log(`capabilities:    ${JSON.stringify(caps)}\n`);

const bus = createObsBus();
bus.subscribe((e) => console.log(`  obs  ${e.kind}  ${e.summary}`));

// ---- the catalog itself, as an operator console would show it ----
console.log(`catalog (${toolCatalog.names.length} tools)`);
if (toolCatalog.names.length === 0) {
  fail('the shipped catalog is empty — every prompt would resolve 0 of n and no turn could call anything');
}
for (const tool of toolCatalog.all) {
  // The INPUT projection, which is what the model is told to send. Printed in full because this is
  // the only place a human sees the document T14 hands to Twilio and T19 renders.
  const schema = toJsonSchema(tool) as { type?: string; properties?: Record<string, unknown> };
  console.log(`  ${tool.name}`);
  console.log(`    requires    ${tool.requires ?? '(nothing — works with zero credentials)'}`);
  console.log(`    args        ${Object.keys(schema.properties ?? {}).join(', ')}`);
  console.log(`    json schema ${JSON.stringify(schema)}`);
  // A tool whose parameters are not an object is rejected by OpenAI mid-turn, as an opaque 400.
  if (schema.type !== 'object') {
    fail(`${tool.name}: JSON Schema type is ${JSON.stringify(schema.type)}, not "object"`);
  }
}

// ---- the boot preflight: the loud half ----
console.log('\npreflight of the compiled defaults (expect no ERROR lines):');
const problems = preflightDefaultPromptTools();
console.log(`  ${problems.length} unknown name(s) across the compiled defaults`);
if (problems.length > 0) {
  fail(
    `a compiled default names a tool the catalog does not have: ${problems
      .map((p) => `${p.prompt} -> ${JSON.stringify(p.name)}`)
      .join(', ')}`,
  );
}

// ---- the live path: whatever Langfuse is serving right now. The reason this script exists. ----
const prompts = createLangfusePromptPort({
  langfuse: app.langfuse,
  bus,
  ttlMs: promptCacheTtlMs(process.env.NODE_ENV),
});

const name = CHANNEL_PROMPT.voice;
const live = await prompts.get(name);
console.log(`\nlive prompt ${name} v${live.version} names: ${JSON.stringify(live.config.tools)}`);
const fromLive = resolve(live.config.tools, {
  capabilities: caps,
  bus,
  conversationId: 'verify-tools',
  channel: 'voice',
});
console.log(`  resolved     ${JSON.stringify(fromLive.resolved.map((t) => t.name))}`);
console.log(`  unknown      ${JSON.stringify(fromLive.unknown)}`);
console.log(`  unavailable  ${JSON.stringify(fromLive.unavailable)}`);

if (live.version === 'fallback') {
  // NOT a failure. The compiled default is the designed answer when Langfuse is unreachable, and
  // T11 has to run with zero credentials — but say plainly that the live half did not happen.
  console.log('  note: served from the compiled fallback, so nothing here exercised Langfuse');
} else if (live.config.tools.length === 0) {
  fail(`${name} v${live.version} names no tools at all — every turn on it is a bare chat`);
} else if (fromLive.unknown.length > 0) {
  fail(
    `${name} v${live.version} names ${fromLive.unknown
      .map((n) => JSON.stringify(n))
      .join(', ')}, which the catalog does not have — the version is stale, run \`pnpm seed:prompts\``,
  );
}
if (fromLive.unavailable.length > 0) {
  // Expected state of a half-configured demo, and `config.missing` already itemised the reason at
  // boot. A note, not a failure — otherwise this script could never pass on a bare laptop.
  console.log(`  note: ${fromLive.unavailable.join(', ')} in the catalog but not configured here`);
}

console.log(
  failures === 0
    ? '\nall checks passed'
    : `\n${failures} check(s) FAILED — see the FAIL lines above (exit 1)`,
);
