/**
 * Push the compiled-in defaults to Langfuse as version 1, labelled `production`.
 *
 *   pnpm seed:prompts
 *
 * The repo owns version 1; Langfuse owns every version after it. Re-running is harmless — an
 * identical body still becomes a new version — so this reports the version it actually got back
 * rather than claiming v1 blindly.
 *
 * Fails loudly with a non-zero exit when Langfuse is not configured, unlike the server, which
 * degrades. This is a tool somebody ran deliberately, and silently doing nothing would be worse.
 *
 * `scripts/` is exempt from the no-console rule and from the vendor boundary. It still imports
 * DEFAULT_PROMPTS rather than restating the prompt text: two copies of a prompt drift, and the
 * drift is invisible until you read a transcript.
 */
import { LangfuseClient } from '@langfuse/client';
import { DEFAULT_PROMPTS, PROMPT_NAMES } from '../server/agent/prompt/defaults.ts';
import { PRODUCTION_LABEL } from '../server/agent/prompt/port.ts';
import { loadConfig, unavailable } from '../server/config.ts';

const app = loadConfig(process.env);
if (app.langfuse === null) {
  console.error('seed:prompts needs a configured Langfuse. Missing or malformed:');
  // Narrowed to the Langfuse feature via the same helper the 503 bodies use, rather than an
  // inline copy of the label. And if that label is ever reworded, print EVERYTHING instead: a
  // heading with nothing under it is a worse diagnostic than an over-broad list.
  const named = unavailable(app, 'prompts + telemetry').missing;
  for (const m of named.length > 0 ? named : app.missing) {
    console.error(`  ${m.name} — ${m.breaks}`);
  }
  console.error('\nStart it with `pnpm langfuse` and check LANGFUSE_* in .env.');
  process.exit(1);
}

const langfuse = new LangfuseClient({
  baseUrl: app.langfuse.baseUrl,
  publicKey: app.langfuse.publicKey,
  secretKey: app.langfuse.secretKey,
});

/**
 * Optional name filter, because seeding is not always an all-or-nothing act.
 *
 * Every run creates a NEW version of each prompt it touches and moves `production` onto it. So
 * re-seeding everything to ship a change to ONE prompt silently relabels the others — and if an
 * operator has since edited one in the Langfuse UI, that edit stops being the live version. Nothing
 * is destroyed (versions are immutable and the label can be moved back), but it is a surprise, and
 * the whole point of the prompt investment is that operator edits are real.
 *
 *   pnpm seed:prompts                      # both
 *   pnpm seed:prompts demo-agent-voice     # just that one
 */
const requested = process.argv.slice(2);
const unknown = requested.filter((n) => !(PROMPT_NAMES as readonly string[]).includes(n));
if (unknown.length > 0) {
  console.error(`unknown prompt name(s): ${unknown.join(', ')}`);
  console.error(`known: ${PROMPT_NAMES.join(', ')}`);
  process.exit(1);
}
const targets: readonly string[] = requested.length > 0 ? requested : PROMPT_NAMES;

console.log(`seeding ${targets.length} prompt(s) into ${app.langfuse.baseUrl}\n`);

let failures = 0;
for (const name of targets as readonly (typeof PROMPT_NAMES)[number][]) {
  const { messages, config } = DEFAULT_PROMPTS[name];
  try {
    const created = await langfuse.prompt.create({
      name,
      type: 'chat',
      prompt: messages.map((m) => ({ role: m.role, content: m.content })),
      config,
      labels: [PRODUCTION_LABEL],
    });
    console.log(`  ${name}: created v${created.version} [${created.labels.join(', ')}]`);
  } catch (err) {
    failures++;
    console.error(`  ${name}: FAILED — ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} of ${targets.length} failed.`);
  process.exit(1);
}
console.log('\ndone. Edit these in the Langfuse UI; move the `production` label to roll back.');
