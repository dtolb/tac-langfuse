/**
 * The voice harness: a fake model, a fake ConversationRelay sender, and the deps bundle both
 * `../voice.test.ts` and `../voice-telemetry.test.ts` drive `handleVoicePrompt` with.
 *
 * Extracted from `../voice.test.ts` when the telemetry proof needed the same harness against a real
 * OpenTelemetry exporter. Nothing here is new behaviour — the fakes and the reasons for their exact
 * shapes moved verbatim, because each one was written to match something measured in the installed
 * `twilio-agent-connect@2.2.0` bundle rather than to be convenient.
 */
import { capabilities, loadConfig } from '../../server/config.ts';
import { createHistory } from '../../server/agent/history.ts';
import { passthroughMemory } from '../../server/agent/memory.ts';
import { createToolCatalog } from '../../server/agent/tools/catalog.ts';
import { resolve } from '../../server/agent/tools/resolve.ts';
import type { ToolDef, ToolLogger } from '../../server/agent/tools/registry.ts';
import type { ModelPort } from '../../server/agent/model/port.ts';
import type { PromptPort } from '../../server/agent/prompt/port.ts';
import type { TurnDeps } from '../../server/agent/types.ts';
import { createObsBus } from '../../server/obs/bus.ts';
import { createConversationRegistry, type ConversationRegistry } from '../../server/obs/conversations.ts';
import { createVoiceTimeline, type VoiceTimeline } from '../../server/obs/voice-timeline.ts';
import type { VoiceDeps, VoiceSender } from '../../server/twilio/voice.ts';
import type { ObsEvent } from '../../shared/events.ts';

export const silentLogger: ToolLogger = { debug: () => {}, warn: () => {}, error: () => {} };

export const promptPort: PromptPort = {
  get: async () => ({
    name: 'demo-agent-voice',
    version: 2,
    label: 'production',
    messages: [{ role: 'system', content: 'You are {{persona}}.' }],
    config: { model: 'gpt-test', tools: [], toolChoice: 'auto', maxSteps: 3 },
    telemetryLink: null,
  }),
};

export interface FakeTurnOptions {
  /**
   * Milliseconds between deltas. Non-zero by default so `turn.ttfa_ms` and `tts.send` are
   * measurably longer than zero — a harness that emits the whole answer in one tick makes every
   * duration assertion pass for the wrong reason.
   */
  readonly deltaDelayMs?: number;
  /** Extra wall-clock before the FIRST delta, so ttfa is distinguishable from the send window. */
  readonly firstDelayMs?: number;
}

export const fakeTurnDeps = (
  deltas: string[],
  text: string,
  events: ObsEvent[],
  opts: FakeTurnOptions = {},
): TurnDeps => {
  const bus = createObsBus();
  bus.subscribe((e) => events.push(e));
  const deltaDelayMs = opts.deltaDelayMs ?? 5;
  const model: ModelPort = {
    stream: () => ({
      tokens: (async function* () {
        if (opts.firstDelayMs !== undefined) {
          await new Promise((r) => void setTimeout(r, opts.firstDelayMs));
        }
        for (const d of deltas) {
          await new Promise((r) => void setTimeout(r, deltaDelayMs));
          yield d;
        }
      })(),
      done: Promise.resolve({
        text,
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        steps: 1,
      }),
    }),
  };
  return {
    prompts: promptPort,
    tools: (names, t) =>
      resolve(names, {
        capabilities: capabilities(loadConfig({})),
        catalog: createToolCatalog([] as ToolDef[]),
        logger: silentLogger,
        bus,
        conversationId: t.conversationId,
        channel: t.channel,
      }),
    model,
    composeMemory: passthroughMemory,
    obs: bus,
    spans: {
      timeStep: async (_n, fn) => fn(),
      startStep: () => ({ update: () => {}, end: () => {} }),
    },
    branding: { persona: 'Ada', companyName: 'Northwind Traders' },
    history: createHistory(),
    logger: silentLogger,
  };
};

export interface RecordingSenderOptions {
  readonly socketOpen?: boolean;
  readonly session?: { pendingHandoffData?: unknown };
  /**
   * Called after each streamed chunk, with its zero-based index. The seam the interrupt test needs:
   * a barge-in is by definition something that happens WHILE we are speaking, so it cannot be
   * simulated from outside the send.
   */
  readonly onToken?: (chunk: string, index: number) => void;
}

export interface RecordingSender {
  readonly sender: VoiceSender;
  readonly streamed: string[];
  readonly spoken: string[];
  readonly signals: (AbortSignal | undefined)[];
  readonly frames: string[];
  readonly order: string[];
}

/**
 * Records what was sent, what signal it was sent with, and any raw frames written to the socket.
 *
 * ── `sendResponse` DRAINS THE PARKED FRAME, BECAUSE THE VENDOR DOES ─────────────────────────────
 *
 * Pass `session` and this fake emulates TAC's drain: `sendResponse` sends the text, then — if
 * `session.pendingHandoffData` is set — writes that frame to the socket and `delete`s the field
 * (`dist/index.js:5245-5254` in the installed 2.2.0 bundle, read rather than assumed). Without this the
 * fake diverged from the vendor on the exact behaviour this feature is built around, which is why a real
 * double-frame bug was invisible to a suite of eleven voice tests: the fallback `sendResponse` on a
 * zero-token turn sent the parked frame as a side effect, and the drain then sent a second bare
 * `{"type":"end"}`.
 *
 * Deliberately NOT emulated: the vendor's closed-socket guard, which throws SYNCHRONOUSLY from a method
 * declared to return a promise. That belongs to the error-path tests, which supply their own sender.
 */
export const recordingSender = (opts: RecordingSenderOptions = {}): RecordingSender => {
  const streamed: string[] = [];
  const spoken: string[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const frames: string[] = [];
  /**
   * One ordered log across BOTH wires, because the property that matters is a sequence: the end
   * frame must come after every token. Two separate arrays can each look right while the order
   * between them is wrong, which is the actual bug (a truncated goodbye).
   */
  const order: string[] = [];
  const socketOpen = opts.socketOpen ?? true;
  const write = (data: string): void => {
    frames.push(data);
    order.push(`frame:${data}`);
  };
  return {
    streamed,
    spoken,
    signals,
    frames,
    order,
    sender: {
      async sendStreamingResponse(_id, stream, options) {
        signals.push(options?.signal);
        let all = '';
        let index = 0;
        for await (const chunk of stream) {
          // Honour the signal the way TAC does, so an aborted turn stops mid-stream here too.
          if (options?.signal?.aborted === true) break;
          all += chunk;
          streamed.push(chunk);
          order.push(`token:${chunk}`);
          opts.onToken?.(chunk, index);
          index += 1;
        }
        return all;
      },
      async sendResponse(_id, message) {
        spoken.push(message);
        order.push(`say:${message}`);
        // TAC's drain, in the order the bundle does it: the text frame first, then the parked handoff
        // frame, then the field is deleted. `sendStreamingResponse` above has NO such drain, which is
        // the asymmetry `server/twilio/voice.ts` exists to cover.
        const session = opts.session;
        if (session !== undefined && session.pendingHandoffData !== undefined) {
          if (socketOpen) write(JSON.stringify(session.pendingHandoffData));
          delete session.pendingHandoffData;
        }
      },
      getWebsocket: () =>
        socketOpen
          ? {
              readyState: 1, // WebSocket.OPEN
              send: write,
            }
          : null,
    },
  };
};

/**
 * A registry with a FAKE root span, for the tests that only care about the voice exit paths.
 *
 * `traceparent: undefined` is deliberate: with no OpenTelemetry provider registered these tests
 * produce no real spans at all, which is what keeps them about the wire behaviour.
 * `../voice-telemetry.test.ts` uses the real registry instead.
 */
export const voiceRegistry = (): ConversationRegistry =>
  createConversationRegistry({
    spanName: 'conversation.voice',
    start: () => ({ traceparent: undefined, update: () => {}, end: () => {} }),
  });

/** The deps bundle, with a fresh timeline unless one is supplied. */
export const voiceDeps = (
  turn: TurnDeps,
  sender: VoiceSender,
  over: { conversations?: ConversationRegistry; timeline?: VoiceTimeline } = {},
): VoiceDeps => ({
  turn,
  conversations: over.conversations ?? voiceRegistry(),
  sender,
  timeline: over.timeline ?? createVoiceTimeline(),
  logger: silentLogger,
});
