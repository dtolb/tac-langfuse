/**
 * OpenTelemetry registration. Loaded via `--import`, BEFORE anything it instruments:
 *
 *   node --import ./server/obs/instrumentation.ts --env-file-if-exists=.env server/index.ts
 *
 * Why not Next's `instrumentation.ts` convention: that file runs in the Next process, and every
 * model call happens in THIS one. Registering there instruments the wrong process and yields an
 * empty Langfuse with nothing to indicate why.
 *
 * Why `--import` and not a plain top-of-file import in index.ts: ESM hoists all imports before
 * any module body runs, so `import './obs/instrumentation.ts'` at the top of index.ts would still
 * be evaluated after — or interleaved with — the modules it needs to patch. `--import` is the
 * only ordering guarantee.
 *
 * This module is deliberately tolerant: with no Langfuse credentials it registers nothing and
 * returns quietly. A missing observability backend must never stop a demo.
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { LangfuseVercelAiSdkIntegration } from '@langfuse/vercel-ai-sdk';
import { registerTelemetry } from 'ai';

const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
const secretKey = process.env.LANGFUSE_SECRET_KEY;
const baseUrl = process.env.LANGFUSE_BASE_URL;

if (!publicKey || !secretKey || !baseUrl) {
  // stderr, not the app logger: logging.ts must not be imported here, because importing it
  // would pull in half the app before instrumentation has had a chance to patch anything.
  process.stderr.write(
    '[otel] LANGFUSE_* not set — tracing disabled. Prompts will use compiled-in defaults.\n',
  );
} else {
  const sdk = new NodeSDK({
    // The Langfuse processor is what turns spans into Langfuse observations. It FILTERS: only
    // spans it recognises as Langfuse or GenAI spans are forwarded, which is why every custom
    // span in this app is created through @langfuse/tracing (see obs/spans.ts).
    spanProcessors: [new LangfuseSpanProcessor()],
  });
  sdk.start();

  // AI SDK 7 uses callback-based telemetry: this integration is what converts its callbacks into
  // OTel spans (`invoke_agent <model>`, `step N`, `chat <model>` — GenAI semantic conventions,
  // NOT the `ai.*` names v6 used). Without it, model calls produce no spans at all.
  registerTelemetry(new LangfuseVercelAiSdkIntegration());

  process.stderr.write(`[otel] tracing to ${baseUrl}\n`);

  // Flush on the way out, or the last turn of a demo — usually the one being asked about — never
  // reaches Langfuse. `beforeExit` does not fire on SIGTERM, hence both.
  const flush = async (): Promise<void> => {
    try {
      await sdk.shutdown();
    } catch {
      /* best effort: never block shutdown on telemetry */
    }
  };
  let flushed = false;
  const once = (): void => {
    if (flushed) return;
    flushed = true;
    void flush();
  };
  process.once('beforeExit', once);
  // Note: index.ts owns SIGTERM/SIGINT and calls flushTelemetry() before closing the server; this
  // is the backstop for paths that bypass it.
  process.once('SIGTERM', once);
  process.once('SIGINT', once);
}
