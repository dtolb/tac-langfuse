/**
 * Diagnostic: prove the prompt port reads live versions AND survives Langfuse going away.
 *
 *   node --env-file-if-exists=.env scripts/verify-prompts.ts
 *
 * Run it twice — once with Langfuse up (expect `v1`, a non-null telemetry link) and once after
 * `docker compose -f docker-compose.langfuse.yml stop langfuse-web` (expect `fallback` and no
 * rejection). The second run is the one that matters: it is the difference between a demo that
 * survives a container hiccup and one that dies in front of a customer.
 *
 * A sibling of verify-model.mjs and verify-telemetry.ts, for the same reason they exist: the
 * failure being guarded against is silent, so it has to be observed rather than reasoned about.
 */
import { CHANNEL_PROMPT, DEFAULT_PROMPTS, PROMPT_NAMES } from '../server/agent/prompt/defaults.ts';
import { createLangfusePromptPort } from '../server/agent/prompt/langfuse.ts';
import { compose } from '../server/agent/prompt/slots.ts';
import { createObsBus } from '../server/obs/bus.ts';
import { loadConfig } from '../server/config.ts';

const app = loadConfig(process.env);
console.log(`langfuse config: ${app.langfuse === null ? 'ABSENT' : app.langfuse.baseUrl}\n`);

const bus = createObsBus();
bus.subscribe((e) => console.log(`  obs  ${e.kind}  ${e.summary}  (${e.durationMs}ms)`));

const prompts = createLangfusePromptPort({ langfuse: app.langfuse, bus });

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
