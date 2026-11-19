/** `/tuning` — ConversationRelay STT/TTS tuning with live apply, per-call timeline, presets and compare. */
import { TuningClient } from './tuning-client.tsx';

export default function TuningPage() {
  return (
    <main className="mx-auto flex w-full max-w-screen-2xl flex-col px-8 pb-8 pt-6" data-testid="tuning">
      <TuningClient />
    </main>
  );
}
