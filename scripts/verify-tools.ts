/**
 * Diagnostic: prove the tool catalog resolves a LIVE prompt's tool names, and that a name nothing
 * answers to degrades instead of breaking the turn.
 *
 *   node --env-file-if-exists=.env scripts/verify-tools.ts
 *
 * The failure being guarded against is silent: a prompt version edited in Langfuse can name
 * anything at all, and the wrong answer — a thrown error, or a turn that quietly offers no tools
 * with nothing anywhere saying so — looks exactly like a working demo until someone reads a
 * transcript. So it is observed rather than reasoned about, the same reason verify-prompts.ts and
 * verify-telemetry.ts exist.
 *
 * Measured on the first run, against Langfuse still holding the pre-T8 seed (v1, naming the two TAC
 * built-ins that do not exist until T14): both names landed in `unknown`, ONE WARN line named both,
 * the `tool.selection` event read `0 of 2 tools resolved — unknown: search_knowledge, send_message`,
 * and nothing threw. After `pnpm seed:prompts` pushed the updated defaults as v2, the same fetch
 * read `2 of 2 tools resolved`. That pair is the point: the second run is the happy path, and the
 * first is what a stale prompt version does to a live call — degraded, loudly, and still answering.
 * The forced case below measured `2 of 4 tools resolved — unknown: no_such_tool — unavailable:
 * search_knowledge`.
 *
 * Reading the output: pino batches its writes to stdout while `console.log` is synchronous, so the
 * WARN and DEBUG lines can land AFTER the block they belong to. They are not missing.
 */
import { z } from 'zod';
import { capabilities, loadConfig } from '../server/config.ts';
import { CHANNEL_PROMPT } from '../server/agent/prompt/defaults.ts';
import { createLangfusePromptPort } from '../server/agent/prompt/langfuse.ts';
import { promptCacheTtlMs } from '../server/agent/prompt/port.ts';
import { childLogger } from '../server/logging.ts';
import { createObsBus } from '../server/obs/bus.ts';
import { DEMO_TOOLS, ABSENT_ORDER_ID, createToolCatalog, toolCatalog } from '../server/agent/tools/catalog.ts';
import { toJsonSchema, type ToolCtx, type ToolDef } from '../server/agent/tools/registry.ts';
import { preflightDefaultPromptTools, resolve } from '../server/agent/tools/resolve.ts';

const app = loadConfig(process.env);
const caps = capabilities(app);
console.log(`langfuse config: ${app.langfuse === null ? 'ABSENT' : app.langfuse.baseUrl}`);
console.log(`capabilities:    ${JSON.stringify(caps)}\n`);

const bus = createObsBus();
bus.subscribe((e) => console.log(`  obs  ${e.kind}  ${e.summary}`));

// ---- the catalog itself, as an operator console would show it ----
console.log(`catalog (${toolCatalog.names.length} tools)`);
for (const tool of toolCatalog.all) {
  const schema = toJsonSchema(tool) as { properties?: Record<string, unknown> };
  console.log(`  ${tool.name}`);
  console.log(`    requires    ${tool.requires ?? '(nothing — works with zero credentials)'}`);
  console.log(`    args        ${Object.keys(schema.properties ?? {}).join(', ')}`);
  console.log(`    json schema ${JSON.stringify(schema)}`);
}

// ---- the boot preflight: the loud half ----
console.log('\npreflight of the compiled defaults (expect no ERROR lines):');
const problems = preflightDefaultPromptTools();
console.log(`  ${problems.length} unknown name(s) across the compiled defaults`);

// ---- the live path: whatever Langfuse is serving right now ----
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

// ---- the case the brief requires observing, forced rather than waited for ----
// A capability-gated tool stands in for T14's TAC built-ins; it is built here rather than shipped,
// because a placeholder tool in the product that exists for a diagnostic is worse than this.
const gated: ToolDef = {
  name: 'search_knowledge',
  description: 'stand-in for the T14 built-in, to exercise the unavailable partition',
  input: z.object({ query: z.string() }),
  requires: 'knowledge',
  execute: async () => ({ ok: true }),
};

console.log('\na prompt naming a nonexistent tool (expect a WARN line, then a partial turn):');
const mixed = resolve(
  ['lookup_order', 'no_such_tool', 'search_knowledge', 'get_store_hours', 'lookup_order'],
  {
    capabilities: caps,
    catalog: createToolCatalog([...DEMO_TOOLS, gated]),
    bus,
    conversationId: 'verify-tools',
    channel: 'bench',
  },
);
console.log(`  resolved     ${JSON.stringify(mixed.resolved.map((t) => t.name))}`);
console.log(`  unknown      ${JSON.stringify(mixed.unknown)}`);
console.log(`  unavailable  ${JSON.stringify(mixed.unavailable)}`);

// ---- and the tools actually run, including both empty cases ----
const ctx: ToolCtx = {
  conversationId: 'verify-tools',
  // The real logger, so the debug line goes through the same PII-scrubbing pino instance the
  // server uses rather than through console.log.
  logger: childLogger('tools'),
};

console.log('\nexecuting both tools:');
for (const [tool, args] of [
  [toolCatalog.get('lookup_order'), { orderId: 'a4721' }],
  [toolCatalog.get('lookup_order'), { orderId: ABSENT_ORDER_ID }],
  [toolCatalog.get('get_store_hours'), { location: 'Downtown' }],
  [toolCatalog.get('get_store_hours'), { location: 'Mars' }],
] as const) {
  if (tool === undefined) continue;
  // Parsed first, exactly as the AI SDK will: the tool body never sees an unvalidated payload.
  const parsed = tool.input.parse(args);
  console.log(`  ${tool.name}(${JSON.stringify(parsed)})`);
  console.log(`    -> ${JSON.stringify(await tool.execute(parsed, ctx))}`);
}
