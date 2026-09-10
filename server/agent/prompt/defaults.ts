/**
 * The compiled-in prompts. These are the ones that actually run when Langfuse is unreachable.
 *
 * Langfuse is six containers and this gets demoed live in front of customers, so the default is
 * held to the standard of a working agent rather than a placeholder: if `langfuse-web` is
 * restarting during a call, the caller should not be able to tell.
 *
 * TWO prompts, not one, because the locked channels are voice and SMS and their response-shape
 * requirements genuinely conflict — brevity and "never emit a character that isn't meant to be
 * spoken" are right on a call and wrong in a text thread. A single prompt would force one channel
 * to carry instructions that damage the other.
 *
 * The two therefore repeat some prose deliberately rather than sharing a fragment. A shared
 * fragment invites an edit that fixes voice and silently changes text, which is the same failure
 * mode as having one prompt in the first place.
 */
import type { ObsChannel } from '../../../shared/events.ts';
import type { PromptConfig, PromptMessage, ResolvedPrompt } from './port.ts';

export const PROMPT_NAMES = ['demo-agent-voice', 'demo-agent-text'] as const;
export type PromptName = (typeof PROMPT_NAMES)[number];

export interface DefaultPrompt {
  readonly messages: readonly PromptMessage[];
  readonly config: PromptConfig;
}

/**
 * Which prompt a channel serves. Exhaustive over `ObsChannel`, so adding a channel without
 * deciding its prompt is a compile error rather than an undefined lookup at the worst moment.
 * `bench` shares the text prompt: the harness exists to exercise the same path SMS takes.
 */
export const CHANNEL_PROMPT: Readonly<Record<ObsChannel, PromptName>> = {
  voice: 'demo-agent-voice',
  sms: 'demo-agent-text',
  bench: 'demo-agent-text',
};

const VOICE_SYSTEM = `You are {{persona}} for {{company_name}}. Today is {{current_date}}.

You are on a live phone call. Everything you say is read aloud by a synthetic voice, and the
caller cannot see anything.

How to speak
- One or two sentences per turn, then stop and let the caller answer. Long turns get interrupted.
- No markdown, no bullet points, no numbered lists, no headings, no emoji. They are either read
  out as noise or dropped silently, and neither is what you meant.
- Spell out anything that has to be heard correctly. Read order numbers and confirmation codes
  one character at a time ("A, four, seven, two"). Say "dollars" rather than "$", "percent"
  rather than "%", and dates as words ("March third").
- Do not read out a web address. Offer to send it in a text message instead.
- Ask for one piece of information at a time.

How to help
- Look up anything specific to {{company_name}} with search_knowledge before you answer:
  policies, hours, pricing, products, order status. Never guess, and never invent a policy that
  merely sounds plausible.
- If what you find does not answer the question, say so plainly and offer to have someone follow
  up, rather than filling the gap yourself.
- Use send_message when the caller needs something in writing, and tell them you are sending it.
- If the caller interrupts you, drop what you were saying and answer the new question.`;

const TEXT_SYSTEM = `You are {{persona}} for {{company_name}}. Today is {{current_date}}.

This conversation is happening over {{channel}}, in writing.

How to write
- Plain text only. Markdown is not rendered here, so **bold** arrives as a word wrapped in
  asterisks and a heading arrives as a stray hash mark.
- A few short sentences is the target. You have more room than a phone call allows, but nobody
  reads six paragraphs on a phone.
- Line breaks are fine and short dashed lists are fine. Tables, code fences and labelled links
  are not — send a bare URL if you need to send one at all.

How to help
- Look up anything specific to {{company_name}} with search_knowledge before you answer:
  policies, hours, pricing, products, order status. Never guess, and never invent a policy that
  merely sounds plausible.
- If what you find does not answer the question, say so plainly and offer to have someone follow
  up, rather than filling the gap yourself.
- Use send_message when the customer needs a separate confirmation rather than a reply in this
  thread.
- Answer the question that was actually asked before adding anything else.`;

export const DEFAULT_PROMPTS: Readonly<Record<PromptName, DefaultPrompt>> = {
  'demo-agent-voice': {
    messages: [{ role: 'system', content: VOICE_SYSTEM }],
    config: {
      model: 'gpt-5.4-mini',
      // Low but not zero: a support agent that phrases the same refusal identically every time
      // sounds like an IVR, which is the impression this whole demo exists to dispel.
      temperature: 0.4,
      tools: ['search_knowledge', 'send_message'],
      toolChoice: 'auto',
      // 3 rather than the schema's 4: every extra step is silence on a live call, and two tool
      // round-trips is already the edge of what a caller will wait through without speaking.
      maxSteps: 3,
    },
  },
  'demo-agent-text': {
    messages: [{ role: 'system', content: TEXT_SYSTEM }],
    config: {
      model: 'gpt-5.4-mini',
      temperature: 0.4,
      tools: ['search_knowledge', 'send_message'],
      toolChoice: 'auto',
      maxSteps: 4,
    },
  },
};

const isPromptName = (name: string): name is PromptName =>
  (PROMPT_NAMES as readonly string[]).includes(name);

/**
 * The compiled default as a `ResolvedPrompt`.
 *
 * `version: 'fallback'` rather than a number because the operator console renders that field
 * where it would otherwise show `v7` — the degraded state is then visible rather than inferred.
 *
 * An unrecognised name resolves to the text prompt rather than throwing: `get()` promises never
 * to reject, and a channel with no prompt at all is dead air. The requested name is preserved in
 * the result so the console still reports what was actually asked for.
 */
export function fallbackPrompt(name: string): ResolvedPrompt {
  const source = DEFAULT_PROMPTS[isPromptName(name) ? name : 'demo-agent-text'];
  return {
    name,
    version: 'fallback',
    label: null,
    messages: source.messages,
    config: source.config,
    telemetryLink: null,
  };
}
