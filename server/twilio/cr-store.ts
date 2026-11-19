import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRESETS, TWILIO_DEFAULTS, type Preset, type Profile } from '../../shared/cr-params.ts';

/** `data/` at the repository root. */
export const DEFAULT_DATA_DIR = fileURLToPath(new URL('../../data/', import.meta.url));

/** The saved ConversationRelay profile, as `data/cr-profile.json` holds it. */
export interface SavedProfile {
  readonly profile: Profile;
  readonly rev: number;
  readonly source: string;
}

/** Reads and writes the saved profile and the presets. */
export interface ProfileStore {
  /** Returns the saved profile. */
  current(): SavedProfile;
  /** Replaces the saved profile and writes it to disk. */
  commit(next: SavedProfile): void;
  /** Returns every preset in creation order. */
  presets(): readonly Preset[];
  /** Creates or replaces the preset called `name`, writes the file and returns every preset. */
  savePreset(name: string, values: Profile): readonly Preset[];
}

const readJson = <T>(path: string, seed: T): T => {
  if (!existsSync(path)) {
    writeFileSync(path, `${JSON.stringify(seed, null, 2)}\n`);
    return seed;
  }
  return JSON.parse(readFileSync(path, 'utf8')) as T;
};

/**
 * Opens the store in `dir`, seeding `cr-profile.json` from `TWILIO_DEFAULTS` (rev 1) and `cr-presets.json`
 * from `PRESETS` when either is absent. Files are read on first access.
 *
 * @param dir - Directory holding both files; created if missing.
 */
export function createProfileStore(dir: string = DEFAULT_DATA_DIR): ProfileStore {
  const profilePath = join(dir, 'cr-profile.json');
  const presetsPath = join(dir, 'cr-presets.json');
  let saved: SavedProfile | null = null;
  let presets: Preset[] | null = null;

  const load = (): { saved: SavedProfile; presets: Preset[] } => {
    if (saved === null || presets === null) {
      mkdirSync(dir, { recursive: true });
      saved = readJson<SavedProfile>(profilePath, { profile: TWILIO_DEFAULTS, rev: 1, source: 'Twilio defaults' });
      saved = { ...saved, profile: { ...TWILIO_DEFAULTS, ...saved.profile, events: 'config-updated' } };
      presets = readJson<Preset[]>(presetsPath, [...PRESETS]);
    }
    return { saved, presets };
  };

  return {
    current: () => load().saved,
    commit(next) {
      load();
      saved = next;
      writeFileSync(profilePath, `${JSON.stringify(next, null, 2)}\n`);
    },
    presets: () => load().presets,
    savePreset(name, values) {
      const existing = load().presets;
      const all = existing.some((p) => p.name === name)
        ? existing.map((p) => (p.name === name ? { name, values } : p))
        : [...existing, { name, values }];
      presets = all;
      writeFileSync(presetsPath, `${JSON.stringify(all, null, 2)}\n`);
      return all;
    },
  };
}
