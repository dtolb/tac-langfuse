import {
  VoiceChannel,
  VoiceTwiMLOptionsConversationRelaySchema,
  type ConversationId,
  type TAC,
  type VoiceChannelConfig,
  type VoiceTwiMLOptionsConversationRelay,
} from 'twilio-agent-connect';
import type { WireValue } from '../../shared/cr-params.ts';
import type { ConfigSocket, CrTuning, VoiceTraces } from './cr-live.ts';

const TYPED: ReadonlySet<string> = new Set(
  Object.keys(VoiceTwiMLOptionsConversationRelaySchema.shape).filter((k) => k !== 'extra' && k !== 'actionUrl'),
);

/**
 * Maps `<ConversationRelay>` attributes onto TAC's customizer output: typed fields where TAC declares one,
 * `extra` for the rest. Never sets `actionUrl`.
 */
export function relayTwimlOptions(attrs: Readonly<Record<string, WireValue>>): VoiceTwiMLOptionsConversationRelay {
  const typed: Record<string, WireValue> = {};
  const extra: Record<string, WireValue> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'actionUrl') continue;
    (TYPED.has(key) ? typed : extra)[key] = value;
  }
  return {
    ...(typed as Partial<VoiceTwiMLOptionsConversationRelay>),
    ...(Object.keys(extra).length > 0 && { extra }),
  } as VoiceTwiMLOptionsConversationRelay;
}

type TacSocket = Parameters<VoiceChannel['handleWebSocketConnection']>[0];

interface ListeningSocket extends ConfigSocket {
  on(event: 'message', listener: (data: unknown) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
}

/** A `VoiceChannel` that also hands every accepted ConversationRelay socket to a `CrTuning`. */
export class TunableVoiceChannel extends VoiceChannel {
  readonly #tuning: CrTuning;

  constructor(tac: TAC, config: VoiceChannelConfig, tuning: CrTuning) {
    super(tac, config);
    this.#tuning = tuning;
  }

  override handleWebSocketConnection(ws: TacSocket): void {
    const socket = ws as unknown as ListeningSocket;
    this.#tuning.socketOpened(socket);
    socket.on('message', (data) => this.#tuning.socketMessage(socket, String(data)));
    socket.on('close', () => this.#tuning.socketClosed(socket));
    super.handleWebSocketConnection(ws);
  }
}

/**
 * Connects `tuning` to `channel`: inbound TwiML carries the saved profile, and TAC's conversation ids are
 * bound to calls as their sockets register. Takes the channel's `webSocketConnected` slot.
 */
export function wireCrTuning(channel: TunableVoiceChannel, tuning: CrTuning, traces: VoiceTraces): void {
  tuning.connectVoice(traces);
  channel.onInboundCallTwiml(async (req) => relayTwimlOptions(tuning.nextCallTwiml(req.callSid)));
  channel.on('webSocketConnected', ({ conversationId }: { conversationId: string }) => {
    const callSid = channel.getConversationSession(conversationId as ConversationId)?.callSid;
    if (callSid !== undefined) tuning.bindConversation(callSid, conversationId);
  });
}
