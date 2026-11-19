import { z } from 'zod';
import {
  CALL_TIMELINE_ROUTE,
  CALLS_PATH,
  TUNING_APPLY_PATH,
  TUNING_PATH,
  TUNING_PRESET_ROUTE,
  type ApiError,
} from '../../shared/tuning-api.ts';
import type { CrTuning } from '../twilio/cr-live.ts';
import type { App } from './types.ts';

const profileSchema = z.record(z.string(), z.string());
const applySchema = z.object({ profile: profileSchema, preset: z.string().nullish() });
const presetSchema = z.object({ values: profileSchema });

/** Registers the routes in `shared/tuning-api.ts` against `tuning`. Bodies that fail validation get a 400 `ApiError`. */
export function registerTuningRoutes(app: App, tuning: CrTuning): void {
  const bad = (message: string): ApiError => ({ error: message });

  app.get(TUNING_PATH, async () => tuning.state());

  app.post(TUNING_APPLY_PATH, async (request, reply) => {
    const parsed = applySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(bad(parsed.error.message));
    return tuning.apply({ profile: parsed.data.profile, preset: parsed.data.preset ?? null });
  });

  app.put<{ Params: { name: string } }>(TUNING_PRESET_ROUTE, async (request, reply) => {
    const parsed = presetSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(bad(parsed.error.message));
    return tuning.savePreset(request.params.name, parsed.data.values);
  });

  app.get(CALLS_PATH, async () => tuning.calls());

  app.get<{ Params: { callSid: string } }>(CALL_TIMELINE_ROUTE, async (request, reply) => {
    const timeline = await tuning.timeline(request.params.callSid);
    if (timeline === null) return reply.code(404).send(bad(`no call ${request.params.callSid} on this agent`));
    return timeline;
  });
}
