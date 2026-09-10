/**
 * `names[]` from a prompt version -> `{resolved, unknown, unavailable}`.
 *
 * The rule governing this file is **fail loud at boot, degrade quiet at runtime**, and it is split
 * across the two exports:
 *
 *  - `resolve()` NEVER throws. A prompt version naming a dead tool must not be able to take a live
 *    phone call down: the turn proceeds with whatever resolved, the missing names are reported on
 *    the obs bus and in one warning, and the caller decides nothing.
 *  - `preflightDefaultPromptTools()` is the loud half. The compiled-in defaults are code, so a name
 *    in one of them that nothing answers to is a bug we can shout about at boot, before a call.
 *
 * No span here. T9 owns the `tools.resolve` span and sets the `tools.unknown` attribute on it, so
 * that number lands in the Metrics tab of the prompt version that caused it. Instrumenting on both
 * sides would put the same step in the Langfuse waterfall twice, which reads as broken tracing.
 */
import type { ObsChannel } from '../../../shared/events.ts';
import type { Capabilities } from '../../config.ts';
import { childLogger } from '../../logging.ts';
import { obsBus, type ObsBus } from '../../obs/bus.ts';
import { DEFAULT_PROMPTS, PROMPT_NAMES } from '../prompt/defaults.ts';
import { toolCatalog, type ToolCatalog } from './catalog.ts';
import type { ToolDef, ToolLogger } from './registry.ts';

const log = childLogger('tools');

export interface ToolResolution {
  readonly resolved: readonly ToolDef[];
  /** Named in the prompt, absent from the catalog. A typo, or a tool that was removed. */
  readonly unknown: readonly string[];
  /** In the catalog, but its `requires` capability is not satisfied by this process. */
  readonly unavailable: readonly string[];
}

export interface ResolveDeps {
  /**
   * From `capabilities(config)`. Taken as a value and never read from the environment, so this
   * stays testable and `server/config.ts` remains the one place env is read.
   */
  readonly capabilities: Capabilities;
  /** Defaults to the shipped catalog. Tests inject a fixture one; there is only ever one at run time. */
  readonly catalog?: ToolCatalog;
  readonly logger?: ToolLogger;
  readonly bus?: Pick<ObsBus, 'publish'>;
  /** Both ride onto the obs event so the console can attribute a selection to its turn. */
  readonly conversationId?: string;
  readonly channel?: ObsChannel;
}

/**
 * Partition the names a prompt asked for.
 *
 * Order is the prompt's, and duplicates collapse to their first occurrence: tool order is part of
 * what a prompt version controls, so it survives the round trip rather than being re-sorted here.
 *
 * There is no try/catch, deliberately. Nothing in the body can throw — Map lookups, array pushes,
 * and a bus whose `publish` swallows subscriber failures itself — so the never-throws contract holds
 * by construction rather than by a blanket catch, which would only hide a real bug in the catalog.
 */
export function resolve(names: readonly string[], deps: ResolveDeps): ToolResolution {
  const catalog = deps.catalog ?? toolCatalog;
  const logger = deps.logger ?? log;
  const bus = deps.bus ?? obsBus;

  const resolved: ToolDef[] = [];
  const unknown: string[] = [];
  const unavailable: string[] = [];
  const seen = new Set<string>();

  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);

    const def = catalog.get(name);
    if (def === undefined) {
      unknown.push(name);
      continue;
    }
    if (def.requires !== undefined && !deps.capabilities[def.requires]) {
      unavailable.push(name);
      continue;
    }
    resolved.push(def);
  }

  const requested = seen.size;

  if (unknown.length > 0) {
    // ONE line per resolve call, not one per name, because this runs on every turn. Names are
    // quoted so an empty or whitespace-only entry is visible rather than reading as a formatting
    // slip — same lesson as the slot markers in `../prompt/slots.ts`.
    logger.warn(
      { unknown, catalog: catalog.names, resolved: resolved.map((t) => t.name) },
      `tools: ${unknown.map((n) => JSON.stringify(n)).join(', ')} not in the catalog — the turn proceeds with ${resolved.length} of ${requested}`,
    );
  }
  if (unavailable.length > 0) {
    // Debug, not warn: an unavailable tool is the expected state of a half-configured demo, and
    // `config.missing` already itemised the reason loudly at boot. A warning per turn here would
    // train the reader to ignore the one above it.
    logger.debug({ unavailable }, `tools: ${unavailable.join(', ')} in the catalog but not configured`);
  }

  const parts = [`${resolved.length} of ${requested} tool${requested === 1 ? '' : 's'} resolved`];
  if (unknown.length > 0) parts.push(`unknown: ${unknown.join(', ')}`);
  if (unavailable.length > 0) parts.push(`unavailable: ${unavailable.join(', ')}`);

  // Published even when nothing was requested. "0 of 0 tools resolved" is the answer to "why did
  // the agent never call a tool?", and that question is asked mid-demo.
  bus.publish({
    kind: 'tool.selection',
    summary: parts.join(' — '),
    ...(deps.channel !== undefined && { channel: deps.channel }),
    ...(deps.conversationId !== undefined && { conversationId: deps.conversationId }),
    payload: {
      // `considered`, not `requested`: this is the DEDUPED set, so a prompt naming a tool twice
      // appears here once — the same collapse the "n of m" count above reports. A field called
      // `requested` would quietly under-report what the prompt version actually asked for.
      considered: [...seen],
      resolved: resolved.map((t) => t.name),
      unknown,
      unavailable,
    },
  });

  return { resolved, unknown, unavailable };
}

/** A compiled-in default naming a tool the catalog does not have. */
export interface UnknownPromptTool {
  readonly prompt: string;
  readonly name: string;
}

/**
 * Boot preflight: every tool name in every entry of `DEFAULT_PROMPTS` must exist in the catalog.
 *
 * ERROR per offending name — this is the loud half of the rule, and it is loud because both sides
 * are code in this repo. A prompt whose names nothing answers to is a checked-in mistake, and the
 * symptom without this is an agent that is merely a bit worse than it should be on every turn.
 *
 * Logs rather than throws: the process still boots. A demo that dies at startup is undebuggable at
 * the worst possible moment, and `resolve()` degrades correctly anyway.
 *
 * Only the compiled defaults are checked. A LIVE Langfuse version can name anything at all, which
 * is exactly what `resolve()`'s `unknown` bucket and its warning exist for.
 */
export function preflightDefaultPromptTools(
  deps: { readonly catalog?: ToolCatalog; readonly logger?: ToolLogger } = {},
): readonly UnknownPromptTool[] {
  const catalog = deps.catalog ?? toolCatalog;
  const logger = deps.logger ?? log;

  const problems: UnknownPromptTool[] = [];
  for (const prompt of PROMPT_NAMES) {
    for (const name of DEFAULT_PROMPTS[prompt].config.tools) {
      if (!catalog.has(name)) problems.push({ prompt, name });
    }
  }

  for (const p of problems) {
    logger.error(
      { prompt: p.prompt, tool: p.name, catalog: catalog.names },
      `tool preflight: compiled prompt ${p.prompt} names ${JSON.stringify(p.name)}, which is not in the tool catalog — every turn on that prompt offers one tool fewer than it says it does`,
    );
  }
  return problems;
}
