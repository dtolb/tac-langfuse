/** `/tuning` — ConversationRelay STT/TTS tuning with live apply, per-call timeline, presets and compare. */
import { CallNumber } from '../call-number.tsx';
import { TuningClient } from './tuning-client.tsx';

export default function TuningPage() {
  return (
    <main className="mx-auto flex w-full max-w-screen-2xl flex-col px-8 pb-8 pt-6" data-testid="tuning">
      <div className="pb-4">
        <CallNumber hint="Apply reaches every live call on its next turn, and the next call" />
      </div>
      <TuningClient />
    </main>
  );
}
