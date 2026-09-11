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
 *
 * `config.tools` is names only, and every name here must exist in the tool catalog
 * (`../tools/catalog.ts`). Nothing in the type system links the two, so it is checked twice:
 * `preflightDefaultPromptTools()` logs an ERROR per unknown name at boot, and `tests/tools.test.ts`
 * fails the build. Both defaults therefore name the two credential-free demo tools — a default that
 * asks for a tool the catalog does not have is a default that quietly does less on every turn.
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
- Do not read out a web address. Offer to have someone send it instead.
- Ask for one piece of information at a time.

How to help
- Use lookup_order for anything about an order: its status, what is on it, when it arrives. Ask
  for the order number if you do not have it, and confirm it back before you look it up.
- Use get_store_hours for the opening hours of a named {{company_name}} location.
- Look something up before you answer it. Never guess an order status or an opening time, and
  never invent a policy that merely sounds plausible.
- If you cannot look something up, or a tool comes back with nothing, say so plainly and offer to
  have someone follow up, rather than filling the gap yourself.
- If the caller interrupts you, drop what you were saying and answer the new question.

How to end the call
- A phone call has to be hung up by someone, and on this channel that is you. Use end_call.
- Call end_call when the caller has clearly finished: they say goodbye, they say that is everything
  or they are all set, or they ask you to end the call. Then say one short goodbye and stop.
- Do not call it while anything is unanswered, and never to get out of a question you would rather
  not answer. If you are unsure whether they are done, ask "anything else I can help with?" and
  wait — asking costs one turn, hanging up early ends the conversation.
- Do not announce it or ask permission to hang up. Say the goodbye and let the call end.`;

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
- Use lookup_order for anything about an order: its status, what is on it, when it arrives. Ask
  for the order number if you do not have it.
- Use get_store_hours for the opening hours of a named {{company_name}} location.
- Look something up before you answer it. Never guess an order status or an opening time, and
  never invent a policy that merely sounds plausible.
- If you cannot look something up, or a tool comes back with nothing, say so plainly and offer to
  have someone follow up, rather than filling the gap yourself.
- Answer the question that was actually asked before adding anything else.`;

/**
 * NO `temperature` in either default, deliberately — see `PromptConfigSchema`, which still accepts
 * one from Langfuse.
 *
 * `gpt-5.4-mini` is a reasoning model and IGNORES `temperature`. The OpenAI provider says so out
 * loud ("The feature \"temperature\" is not supported"), so a Langfuse prompt version that sets one
 * is a self-reporting mistake an operator can fix in the web form with no redeploy — which is the
 * design working, and why there is deliberately no model-name guard in code.
 *
 * The compiled default is the one config an operator CANNOT fix that way: it is what a bare-laptop
 * run and a Langfuse outage both fall back to, and changing it needs a deploy. So it must not ship a
 * parameter the default model discards.
 *
 * If you point `model` at a non-reasoning model (`gpt-4.1`, `gpt-4o`), `temperature: 0.4` is the
 * value to put back and the reasoning is this: low but not zero, because a support agent that
 * phrases the same refusal identically every time sounds like an IVR, which is the impression this
 * whole demo exists to dispel.
 */
export const DEFAULT_PROMPTS: Readonly<Record<PromptName, DefaultPrompt>> = {
  'demo-agent-voice': {
    messages: [{ role: 'system', content: VOICE_SYSTEM }],
    config: {
      model: 'gpt-5.4-mini',
      // `end_call` is voice-only — it is what lets the agent hang up, and the text prompt must not
      // name it. Note it costs a step: the model calls it and then speaks the goodbye, so a closing
      // turn uses two of the three below.
      tools: ['lookup_order', 'get_store_hours', 'end_call'],
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
      tools: ['lookup_order', 'get_store_hours'],
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
