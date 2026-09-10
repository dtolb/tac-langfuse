/**
 * The prompt seam. NO vendor imports here, deliberately: this file is what makes the
 * compiled-in fallback testable without a Langfuse to fail against.
 *
 * The load-bearing decision is what lives in `config`. Model, temperature, `maxSteps` AND the
 * set of enabled tools are all versioned *with the prompt text*, so changing any of them is a
 * new Langfuse version plus a label move — no redeploy, no container restart — and rollback is
 * moving the label back. That is the whole reason this project self-hosts 2.7 GB of Langfuse.
 */
import { z } from 'zod';

/**
 * `.strict()` is load-bearing.
 *
 * Langfuse's prompt `config` is free-form JSON edited in a web form, so `max_steps` where the
 * schema says `maxSteps` is a plausible Tuesday afternoon. Zod's default behaviour — strip the
 * unknown key — would serve `maxSteps: 4` while the operator believes they set 8, and nothing
 * anywhere would say so. Failing validation instead sends the whole prompt to the compiled
 * default with a named warning, which is loud.
 */
export const PromptConfigSchema = z
  .object({
    model: z.string().default('gpt-5.4-mini'),
    temperature: z.number().min(0).max(2).optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    /**
     * NAMES ONLY, never schemas. Schemas live in the code-owned catalog (T8), so a Langfuse
     * edit *selects from* an allowlist and structurally cannot add a new tool or change an
     * existing one's arguments.
     */
    tools: z.array(z.string()).default([]),
    toolChoice: z.enum(['auto', 'none', 'required']).default('auto'),
    /** 8 is a ceiling, not a target: a runaway tool loop on a live call is minutes of dead air. */
    maxSteps: z.number().int().min(1).max(8).default(4),
  })
  .strict();

export type PromptConfig = z.infer<typeof PromptConfigSchema>;

export interface PromptMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface ResolvedPrompt {
  readonly name: string;
  /** Langfuse version number, or the literal string 'fallback' when the compiled default was used. */
  readonly version: number | 'fallback';
  readonly label: string | null;
  readonly messages: readonly PromptMessage[]; // still contains raw {{var}} placeholders
  readonly config: PromptConfig;
  /** p.toJSON() — pass as experimental_telemetry.metadata.langfusePrompt to link trace -> version. null on fallback. */
  readonly telemetryLink: unknown | null;
}

export interface PromptPort {
  /** Never throws. Never rejects. Falls back to the compiled default on any failure. */
  get(name: string): Promise<ResolvedPrompt>;
}

/**
 * The label the app serves. Everything fetches BY LABEL and never by version number, which is
 * what makes "move the label to roll back" work at all.
 */
export const PRODUCTION_LABEL = 'production';

/**
 * Cache TTL. Short in development because the demo loop is "edit the prompt in Langfuse, place
 * another call" and a 60 s wait breaks that rhythm; longer in production because a cache hit is
 * the difference between ~0 ms and a network round-trip inside the `prompt.fetch` span, and that
 * span sits in front of the first spoken word.
 */
export const PROMPT_CACHE_TTL_DEV_MS = 20_000;
export const PROMPT_CACHE_TTL_PROD_MS = 60_000;

/** Takes NODE_ENV as a value rather than reading it, so this file stays free of globals. */
export const promptCacheTtlMs = (nodeEnv: string | undefined): number =>
  nodeEnv === 'production' ? PROMPT_CACHE_TTL_PROD_MS : PROMPT_CACHE_TTL_DEV_MS;
