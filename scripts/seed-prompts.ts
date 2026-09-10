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

console.log(`seeding ${PROMPT_NAMES.length} prompts into ${app.langfuse.baseUrl}\n`);

let failures = 0;
for (const name of PROMPT_NAMES) {
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
  console.error(`\n${failures} of ${PROMPT_NAMES.length} failed.`);
  process.exit(1);
}
console.log('\ndone. Edit these in the Langfuse UI; move the `production` label to roll back.');
