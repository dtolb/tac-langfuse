/**
 * Environment configuration. THIS MODULE NEVER THROWS.
 *
 * That is the whole design constraint. A demo that dies at boot because one variable is
 * missing is undebuggable at the worst possible moment; a demo that boots, says exactly what
 * is missing, serves /health, renders its page, and 503s only the routes that genuinely
 * cannot work is debuggable in front of a customer.
 *
 * Note `TACConfig.fromEnv()` DOES throw on any of its five required variables, so it must
 * only ever be called once `twilio !== null` below. That check is this file's main job.
 *
 * `loadConfig` takes an env object rather than reading `process.env` directly, so every route
 * is testable by passing a literal — the pattern from aci-quality-poc and nw-poc, where
 * `routes.ts` is the only file that reads the environment.
 */
import { z } from 'zod';

export type Env = Record<string, string | undefined>;

/** What a missing variable costs, so the warning and the 503 can both say it. */
export interface MissingVar {
  readonly name: string;
  readonly feature: string;
  readonly breaks: string;
}

const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * TAC's OWN shapes for these two, copied deliberately rather than loosened.
 *
 * Both are validated by `TACConfigSchema` inside the vendor, and a value that fails there throws a
 * raw `ZodError` out of `new TACConfig(...)` — i.e. at boot, after this module has already reported
 * the capability as available. That is the one way a malformed-but-present value can still hard-fail
 * boot despite this file never throwing, so the check belongs here where it becomes a warning and a
 * 503 instead.
 *
 * Note `STUDIO_FLOW_SID` is **lowercase hex only** in TAC's regex (`/^FW[0-9a-f]{32}$/`). A SID
 * pasted from a source that upper-cases it is the realistic failure, and it is invisible until boot.
 */
const CONV_CONFIGURATION_ID = /^conv_configuration_[0-9a-z]{26}$/;
const STUDIO_FLOW_SID = /^FW[0-9a-f]{32}$/;

const twilioSchema = z.object({
  accountSid: z.string().regex(/^AC[0-9a-fA-F]{32}$/, 'must look like AC + 32 hex chars'),
  authToken: z.string().min(1),
  apiKey: z.string().regex(/^SK[0-9a-fA-F]{32}$/, 'must look like SK + 32 hex chars'),
  apiSecret: z.string().min(1),
  phoneNumber: z.string().regex(E164, 'must be E.164, e.g. +15551234567'),
});

const voiceSchema = z.object({
  /**
   * Scheme-less, per TAC. A port and a base path are both legal
   * (`example.ngrok.app:8080`, `example.com/server1`); a scheme is not.
   */
  publicDomain: z
    .string()
    .min(1)
    .refine((v) => !/^https?:\/\//i.test(v), 'must NOT include https:// — TAC wants the bare host'),
});

const openaiSchema = z.object({
  apiKey: z.string().min(1),
});

const langfuseSchema = z.object({
  baseUrl: z.string().url(),
  publicKey: z.string().min(1),
  secretKey: z.string().min(1),
});

export interface AppConfig {
  /** Non-null only when all five TAC-required variables are present AND well-formed. */
  readonly twilio: z.infer<typeof twilioSchema> | null;
  /** Non-null only when voice can actually be served. TACServer throws without this. */
  readonly voice: z.infer<typeof voiceSchema> | null;
  /** Orchestrated mode. Without it: no SMS channel, no Memory, no Knowledge, no handoff. */
  readonly conversationConfigurationId: string | null;
  readonly studioHandoffFlowSid: string | null;
  readonly knowledgeBaseId: string | null;
  readonly openai: z.infer<typeof openaiSchema> | null;
  readonly langfuse: z.infer<typeof langfuseSchema> | null;
  /** Traefik router names are global on the box, so this must be unique per clone. */
  readonly appName: string;
  readonly logLevel: string;
  readonly missing: readonly MissingVar[];
}

/** Capability flags derived from config — what this process can actually do right now. */
export interface Capabilities {
  readonly llm: boolean;
  readonly prompts: boolean;
  readonly voice: boolean;
  readonly sms: boolean;
  readonly memory: boolean;
  readonly handoff: boolean;
  readonly knowledge: boolean;
}

const pick = (env: Env, ...names: string[]): (string | undefined)[] =>
  names.map((n) => {
    const v = env[n];
    return v === undefined || v.trim() === '' ? undefined : v.trim();
  });

export function loadConfig(env: Env): AppConfig {
  const missing: MissingVar[] = [];
  const note = (name: string, feature: string, breaks: string): void => {
    missing.push({ name, feature, breaks });
  };

  // --- Twilio core: all five, or none of TAC works ---
  const [accountSid, authToken, apiKey, apiSecret, phoneNumber] = pick(
    env,
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_API_KEY',
    'TWILIO_API_SECRET',
    'TWILIO_PHONE_NUMBER',
  );
  const twilioParsed = twilioSchema.safeParse({
    accountSid,
    authToken,
    apiKey,
    apiSecret,
    phoneNumber,
  });
  if (!twilioParsed.success) {
    for (const issue of twilioParsed.error.issues) {
      const field = String(issue.path[0] ?? '?');
      const envName =
        {
          accountSid: 'TWILIO_ACCOUNT_SID',
          authToken: 'TWILIO_AUTH_TOKEN',
          apiKey: 'TWILIO_API_KEY',
          apiSecret: 'TWILIO_API_SECRET',
          phoneNumber: 'TWILIO_PHONE_NUMBER',
        }[field] ?? field;
      note(envName, 'Twilio', `${issue.message} — no channel can start`);
    }
  }

  // --- Voice ---
  const [publicDomain] = pick(env, 'TWILIO_VOICE_PUBLIC_DOMAIN');
  const voiceParsed = voiceSchema.safeParse({ publicDomain });
  if (!voiceParsed.success) {
    for (const issue of voiceParsed.error.issues) {
      note(
        'TWILIO_VOICE_PUBLIC_DOMAIN',
        'voice',
        `${issue.message} — TACServer throws at construction, so voice cannot be registered`,
      );
    }
  }

  // --- Orchestrated mode and the tools it unlocks ---
  const [conversationConfigurationId, studioHandoffFlowSid, knowledgeBaseId] = pick(
    env,
    'TWILIO_CONVERSATION_CONFIGURATION_ID',
    'TWILIO_STUDIO_HANDOFF_FLOW_SID',
    'TWILIO_KNOWLEDGE_BASE_ID',
  );
  // Present-but-malformed is treated exactly like absent, and that is the point: TAC re-validates both
  // and throws at construction, so accepting a typo here would report `sms: true` and then take the
  // whole process down at boot. Degrading at the gate keeps that a warning plus a 503.
  const coIdOk = conversationConfigurationId !== undefined && CONV_CONFIGURATION_ID.test(conversationConfigurationId);
  const flowSidOk = studioHandoffFlowSid !== undefined && STUDIO_FLOW_SID.test(studioHandoffFlowSid);

  if (!coIdOk) {
    note(
      'TWILIO_CONVERSATION_CONFIGURATION_ID',
      'orchestrated mode',
      conversationConfigurationId === undefined
        ? 'new SMSChannel() THROWS without it; Memory, Knowledge and handoff are all unavailable'
        : 'must look like conv_configuration_ + 26 lowercase alphanumerics — TAC rejects it at construction, so SMS is treated as unconfigured rather than crashing boot',
    );
  }
  if (!flowSidOk) {
    note(
      'TWILIO_STUDIO_HANDOFF_FLOW_SID',
      'handoff',
      studioHandoffFlowSid === undefined
        ? 'createStudioHandoffTool() throws at construction — the tool is omitted rather than risking dead air'
        : 'must be FW + 32 LOWERCASE hex chars — TAC rejects it at construction, so handoff is treated as unconfigured',
    );
  }

  // --- LLM ---
  const [openaiKey] = pick(env, 'OPENAI_API_KEY');
  const openaiParsed = openaiSchema.safeParse({ apiKey: openaiKey });
  if (!openaiParsed.success) {
    note(
      'OPENAI_API_KEY',
      'agent',
      'the agent cannot answer at all (note: the AI SDK reads exactly this name, not OPENAI_APIKEY)',
    );
  }

  // --- Langfuse: prompts + telemetry ---
  const [lfBase, lfPublic, lfSecret] = pick(
    env,
    'LANGFUSE_BASE_URL',
    'LANGFUSE_PUBLIC_KEY',
    'LANGFUSE_SECRET_KEY',
  );
  const langfuseParsed = langfuseSchema.safeParse({
    baseUrl: lfBase,
    publicKey: lfPublic,
    secretKey: lfSecret,
  });
  if (!langfuseParsed.success) {
    note(
      'LANGFUSE_BASE_URL / LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY',
      'prompts + telemetry',
      'prompts fall back to the compiled-in defaults (version "fallback") and no traces are recorded',
    );
  }

  return {
    twilio: twilioParsed.success ? twilioParsed.data : null,
    voice: voiceParsed.success ? voiceParsed.data : null,
    // `null` unless well-formed, so `capabilities()` and every consumer see one notion of "usable"
    // and `server/twilio/` can construct TACConfig without re-checking.
    conversationConfigurationId: coIdOk ? conversationConfigurationId : null,
    studioHandoffFlowSid: flowSidOk ? studioHandoffFlowSid : null,
    knowledgeBaseId: knowledgeBaseId ?? null,
    openai: openaiParsed.success ? openaiParsed.data : null,
    langfuse: langfuseParsed.success ? langfuseParsed.data : null,
    appName: env.APP_NAME?.trim() || 'scaffold',
    logLevel: env.TWILIO_LOG_LEVEL?.trim() || 'info',
    missing,
  };
}

export function capabilities(c: AppConfig): Capabilities {
  const orchestrated = c.twilio !== null && c.conversationConfigurationId !== null;
  return {
    llm: c.openai !== null,
    prompts: c.langfuse !== null,
    voice: c.twilio !== null && c.voice !== null,
    sms: orchestrated,
    memory: orchestrated,
    handoff: orchestrated && c.studioHandoffFlowSid !== null,
    knowledge: orchestrated && c.knowledgeBaseId !== null,
  };
}

/**
 * The 503 body for a route whose capability is unavailable. Names the variable, because
 * "service unavailable" with no cause is the least useful thing a demo can say.
 */
export function unavailable(c: AppConfig, feature: string): {
  error: string;
  feature: string;
  missing: readonly MissingVar[];
} {
  return {
    error: 'not_configured',
    feature,
    missing: c.missing.filter((m) => m.feature === feature),
  };
}
