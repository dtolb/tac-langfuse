// Diagnostic: prove the configured model actually works, and settle which AI SDK 7 entry
// point runs the tool loop. Run with:
//   node --env-file-if-exists=.env scripts/verify-model.mjs
//
// Kept rather than thrown away because "is my key good and do tools execute" is the first
// question worth answering on any new machine or new demo.
import { createOpenAI } from '@ai-sdk/openai';
import { generateText, streamText, ToolLoopAgent, tool, jsonSchema, stepCountIs } from 'ai';

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('OPENAI_API_KEY is not set. The AI SDK reads exactly that name.');
  process.exit(1);
}
console.log(`key present: ${apiKey.slice(0, 7)}... (${apiKey.length} chars)`);

// --- which models can this key actually see? ---
const res = await fetch('https://api.openai.com/v1/models', {
  headers: { Authorization: `Bearer ${apiKey}` },
});
if (!res.ok) {
  console.error(`models list failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  process.exit(1);
}
const all = (await res.json()).data.map((m) => m.id);
const chatish = all
  .filter((m) => /^(gpt|o[0-9])/.test(m) && !/audio|realtime|image|tts|whisper|embed|moderation/.test(m))
  .sort();
console.log(`models visible: ${all.length} (${chatish.length} chat-capable)`);
console.log(`  sample: ${chatish.slice(0, 12).join(', ')}`);

const MODEL =
  process.env.MODEL ??
  ['gpt-5.4-mini', 'gpt-5-mini', 'gpt-4.1-mini', 'gpt-4o-mini'].find((m) => chatish.includes(m)) ??
  chatish[0];
console.log(`using model: ${MODEL}\n`);

const openai = createOpenAI({ apiKey });

// A tool built from RAW JSON Schema — the shape `fromTacTool()` will produce when adapting
// TAC's built-ins, so this is the path that must work without any Zod mirror.
const makeTool = (calls) =>
  tool({
    description: 'Look up how long refunds take for a given region.',
    inputSchema: jsonSchema({
      type: 'object',
      properties: { region: { type: 'string', description: 'Region code, e.g. US' } },
      required: ['region'],
    }),
    execute: async (args) => {
      calls.push(args);
      return { businessDays: 2, region: args.region };
    },
  });

const PROMPT = 'How long do refunds take in the US? Use the tool, then answer in one short sentence.';

async function viaGenerateText() {
  const calls = [];
  const r = await generateText({
    model: openai(MODEL),
    prompt: PROMPT,
    tools: { refund_eta: makeTool(calls) },
    stopWhen: stepCountIs(4),
  });
  return { calls, text: r.text, steps: r.steps?.length ?? 0 };
}

async function viaStreamText() {
  const calls = [];
  const r = streamText({
    model: openai(MODEL),
    prompt: PROMPT,
    tools: { refund_eta: makeTool(calls) },
    stopWhen: stepCountIs(4),
  });
  let text = '';
  let ttft = null;
  const t0 = Date.now();
  for await (const d of r.textStream) {
    if (ttft === null && d.length) ttft = Date.now() - t0;
    text += d;
  }
  return { calls, text, ttft, steps: (await r.steps)?.length ?? 0 };
}

async function viaToolLoopAgent() {
  const calls = [];
  const agent = new ToolLoopAgent({
    model: openai(MODEL),
    instructions: 'Be brief.',
    tools: { refund_eta: makeTool(calls) },
    stopWhen: stepCountIs(4),
  });
  const r = await agent.stream({ prompt: PROMPT }); // NOTE: returns a Promise
  let text = '';
  let ttft = null;
  const t0 = Date.now();
  for await (const d of r.textStream) {
    if (ttft === null && d.length) ttft = Date.now() - t0;
    text += d;
  }
  return { calls, text, ttft, steps: (await r.steps)?.length ?? 0 };
}

const results = {};
for (const [label, fn] of [
  ['generateText', viaGenerateText],
  ['streamText', viaStreamText],
  ['ToolLoopAgent', viaToolLoopAgent],
]) {
  try {
    const out = await fn();
    results[label] = out;
    console.log(`${label.padEnd(14)} tool_calls=${out.calls.length} steps=${out.steps} ttft=${out.ttft ?? '-'}ms`);
    console.log(`${''.padEnd(14)} args=${JSON.stringify(out.calls)}`);
    console.log(`${''.padEnd(14)} text=${JSON.stringify((out.text ?? '').slice(0, 90))}`);
  } catch (e) {
    results[label] = { error: e.message };
    console.log(`${label.padEnd(14)} ERROR ${e.message.slice(0, 140)}`);
  }
}

console.log('\n--- VERDICT ---');
for (const [label, r] of Object.entries(results)) {
  const ok = !r.error && r.calls?.length > 0 && (r.text ?? '').length > 0;
  console.log(`${label.padEnd(14)} ${ok ? 'PASS — executes tools and returns text' : 'FAIL — ' + (r.error ?? `tool_calls=${r.calls?.length ?? 0}, text=${(r.text ?? '').length} chars`)}`);
}
