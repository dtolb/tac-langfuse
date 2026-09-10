/**
 * Diagnostic: prove the prompt port reads live versions AND survives Langfuse going away.
 *
 *   node --env-file-if-exists=.env scripts/verify-prompts.ts
 *
 * Run it three times. Langfuse up: expect `v1` and a non-null telemetry link. Langfuse STOPPED
 * (`docker compose -f docker-compose.langfuse.yml stop langfuse-web`): expect `fallback`, fast,
 * because a refused connection fails immediately.
 *
 * Then the run that matters, and the one a `stop` does NOT exercise — Langfuse HUNG:
 *
 *   docker pause scaffold-langfuse-web-1     # then this script; then ALWAYS unpause
 *
 * A paused container accepts the connection and never answers, which is the only way to reach the
 * `fetchTimeoutMs` budget in langfuse.ts — and the more realistic live-demo failure than a refused
 * port. Measured: 2009 ms and 2004 ms for the two uncached gets against the 2000 ms budget, then
 * `version: fallback`; the second get of each is a cached fallback at 0 ms. That last part is the
 * point of caching fallbacks: one 2 s pause per TTL window, not one per turn.
 *
 * A sibling of verify-model.mjs and verify-telemetry.ts, for the same reason they exist: the
 * failure being guarded against is silent, so it has to be observed rather than reasoned about.
 */
import { CHANNEL_PROMPT, DEFAULT_PROMPTS, PROMPT_NAMES } from '../server/agent/prompt/defaults.ts';
import { createLangfusePromptPort } from '../server/agent/prompt/langfuse.ts';
import { promptCacheTtlMs } from '../server/agent/prompt/port.ts';
import { compose } from '../server/agent/prompt/slots.ts';
import { createObsBus } from '../server/obs/bus.ts';
import { loadConfig } from '../server/config.ts';

const app = loadConfig(process.env);
console.log(`langfuse config: ${app.langfuse === null ? 'ABSENT' : app.langfuse.baseUrl}\n`);

const bus = createObsBus();
bus.subscribe((e) => console.log(`  obs  ${e.kind}  ${e.summary}  (${e.durationMs}ms)`));

// The port takes its TTL rather than reading NODE_ENV: `promptCacheTtlMs` is the documented policy
// and the caller applies it. This script is a caller, so it applies it here.
const prompts = createLangfusePromptPort({
  langfuse: app.langfuse,
  bus,
  ttlMs: promptCacheTtlMs(process.env.NODE_ENV),
});

for (const name of PROMPT_NAMES) {
  const p = await prompts.get(name);
  const isCompiledDefault = p.messages[0]?.content === DEFAULT_PROMPTS[name].messages[0]?.content;

  console.log(`${name}`);
  console.log(`  version        ${p.version}`);
  console.log(`  label          ${p.label}`);
  console.log(`  telemetryLink  ${p.telemetryLink === null ? 'null' : 'present'}`);
  console.log(`  config         ${JSON.stringify(p.config)}`);
  console.log(`  messages       ${p.messages.length}, matches compiled default: ${isCompiledDefault}`);

  // Second call: must be a cache hit, so ~0ms and no network.
  await prompts.get(name);
  console.log('');
}

// Slot substitution, including both markers, against the voice default.
const composed = compose(
  [
    ...DEFAULT_PROMPTS['demo-agent-voice'].messages,
    { role: 'system', content: 'company={{company_name}} typo={{compnay_name}} persona={{persona}}' },
  ],
  { company_name: 'Northwind Traders', channel: 'voice', current_date: 'Thursday 10 September 2026' },
);
console.log('slots (persona deliberately omitted, company_name deliberately misspelt):');
console.log(`  ${composed.at(-1)?.content}`);

console.log(`\nchannel -> prompt: ${JSON.stringify(CHANNEL_PROMPT)}`);
