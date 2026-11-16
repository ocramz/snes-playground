/**
 * The save on the host (port_v2 phase 7; "Host owns platform"): core's Save
 * singleton loaded from localStorage at boot and written back whenever core
 * marks it changed (`Save.version`). `?save=fresh` starts from an empty save
 * kept in memory; `?nosave` keeps the stored one but writes nothing back.
 * A copy that does not parse is kept aside under `<key>-bad` and the game
 * starts fresh.
 */
import type { World } from 'koota';
import { Save } from '../../../core/traits/save';
import { emptySave, type SaveData } from '../../../core/save';

export const SAVE_KEY = 'kdc-engine-save-v1';

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function parseSave(text: string | null): SaveData | null {
  if (!text) return null;
  try {
    const d = JSON.parse(text) as SaveData;
    if (d.version !== 1 || !Array.isArray(d.members) || d.members.length !== 5 || !Array.isArray(d.rankings)) return null;
    return d;
  } catch {
    return null;
  }
}

export class SaveStore {
  private written = -1;

  constructor(private readonly mode: 'store' | 'fresh' | 'readonly') {}

  /** Put the stored save (or an empty one) into the world. */
  load(world: World): void {
    const s = world.get(Save)!;
    let data: SaveData | null = null;
    if (this.mode !== 'fresh') {
      const st = storage();
      const raw = st?.getItem(SAVE_KEY) ?? null;
      data = parseSave(raw);
      if (raw && !data) st?.setItem(`${SAVE_KEY}-bad`, raw);
    }
    s.data = data ?? emptySave();
    this.written = s.version;
  }

  /** Write the save back if core changed it since. */
  sync(world: World): void {
    const s = world.get(Save);
    if (!s || s.version === this.written) return;
    this.written = s.version;
    if (this.mode !== 'store') return;
    storage()?.setItem(SAVE_KEY, JSON.stringify(s.data));
  }
}
