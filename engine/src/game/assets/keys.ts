/**
 * Every asset key the game uses, in one place (reference §4). The loader
 * serves ../build/engine as the public dir, so the paths are URLs there.
 * Core never imports this: it keeps semantic `Visual.kind` values, and the
 * view catalog maps those to these keys.
 */
export const Rules = {
  /** build/engine/rules/tables.json — the ROM physics constants. */
  tables: 'rules:tables',
} as const;

export const RulesUrl = {
  tables: '/rules/tables.json',
} as const;

// Land with the asset pipeline (implementation step 2):
//   atlas sprites.png/sprites.json, ui.png/ui.json, hud_*.png, font.png,
//   audio.json + sfx/song files, cutscenes.json, assets/holes/NN/*.
