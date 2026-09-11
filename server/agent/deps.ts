/**
 * Build the live `TurnDeps` from configuration — the one place the real ports are wired together.
 *
 * Lived in `../http/routes-bench.ts` as `createBenchTurnDeps` until T12, when SMS needed the identical
 * set and the "bench" in the name became actively misleading. Nothing in here was ever bench-specific:
 * the whole point of `runTurn` is that voice, SMS and the bench differ only in their caller, and they
 * share these ports.
 *
 * Sharing them is deliberate rather than incidental. One prompt port means one cache, so an SMS turn
 * benefits from a warm entry the bench already fetched; one history store means one set of caps rather
 * than two competing ones.
 *
 * Kept separate from every caller so a route or a channel can be exercised against fakes — the route
 * takes `TurnDeps` injected and only this function knows how to construct the live thing. Same seam
 * `scripts/verify-turn.ts` uses.
 */
import { capabilities, type AppConfig } from '../config.ts';
import type { ObsBus } from '../obs/bus.ts';
import { passthroughMemory } from './memory.ts';
import { createOpenAiModelPort } from './model/openai.ts';
import { createLangfusePromptPort } from './prompt/langfuse.ts';
import { promptCacheTtlMs } from './prompt/port.ts';
import { turnSpans } from './spans.ts';
import { resolve } from './tools/resolve.ts';
import type { HistoryPort, TurnDeps } from './types.ts';

export function createTurnDeps(deps: {
  readonly config: AppConfig;
  readonly bus: ObsBus;
  readonly history: HistoryPort;
  readonly nodeEnv: string | undefined;
}): TurnDeps {
  const { config, bus, history } = deps;
  if (config.openai === null) {
    // Unreachable through the bench route, which gates on `caps.llm` first. Explicit anyway: the
    // alternative is a confusing null-deref inside the model port on a misconfigured box.
    throw new Error('createTurnDeps requires OPENAI_API_KEY; gate on capabilities.llm first');
  }
  return {
    prompts: createLangfusePromptPort({
      langfuse: config.langfuse,
      bus,
      ttlMs: promptCacheTtlMs(deps.nodeEnv),
    }),
    // T8's resolver with its process-wide arguments applied. `capabilities` comes from config,
    // which is why `server/agent/` never reads the environment itself.
    tools: (names, turn) =>
      resolve(names, {
        capabilities: capabilities(config),
        bus,
        conversationId: turn.conversationId,
        channel: turn.channel,
      }),
    model: createOpenAiModelPort({ apiKey: config.openai.apiKey }),
    // SMS runs `memoryMode: 'never'` at T12, so this is correct for every channel today. T14 swaps in
    // the TAC-backed port for the channels that have one.
    composeMemory: passthroughMemory,
    obs: bus,
    spans: turnSpans,
    branding: { persona: 'Ada, a customer support agent', companyName: 'Northwind Traders' },
    history,
  };
}
