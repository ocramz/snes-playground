/**
 * The architecture rule (plans/port_v1_koota_phaser4.md): Koota owns state
 * and rules, Phaser is the platform, and only the bridge touches both — so
 * nothing under src/core may import Phaser. Checked statically so the rule
 * holds from the first commit, before there is any core code to speak of.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = fileURLToPath(new URL('.', import.meta.url));
const core = resolve(here, '../src/core');

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = resolve(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (/\.[cm]?[jt]s$/.test(name)) yield path;
  }
}

describe('src/core imports koota only', () => {
  // import/export-from/require of the phaser package; mentions in comments
  // (e.g. "the Phaser host") are fine and expected.
  const use = /(?:import\s[^'"]*|export\s[^'"]*from\s*|require\()\s*['"]phaser(?:\/[^'"]*)?['"]/;
  it('no file under src/core imports phaser', () => {
    const offenders: string[] = [];
    for (const path of walk(core)) {
      if (use.test(readFileSync(path, 'utf8'))) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * The bridge's pure half (plans phase 7 §7.2): the modules the node tests
 * run — the clock, the frame loop, the history, the placement, the catalog
 * data, the event table, the replay, the panel's and the guide's layout, the
 * HUD's state, the text encoding, the asset schemas — import only core, koota
 * and each other, so nothing reaches phaser through them.
 */
const game = resolve(here, '../src/game');
const PURE = [
  'bridge/tick-time.ts', 'bridge/history.ts', 'bridge/frame-loop.ts', 'bridge/placement.ts',
  'features/catalog-data.ts', 'features/kirby/pose-clips.ts', 'features/audio/event-table.ts',
  'features/cutscene/replay.ts', 'features/cutscene/director.ts', 'features/shot-panel/panel-layout.ts', 'features/shot-panel/panel-state.ts',
  'features/guide/guide-dots.ts', 'features/hud/hud-state.ts', 'features/text/encoding.ts',
  'features/enemies/cup-mask.ts', 'features/warp/warp-frames.ts', 'features/layers/styled.ts',
  'features/kirby/sprite-rules.ts', 'features/layers/layer-depth.ts',
  'assets/schema.ts', 'config.ts',
];

describe('the pure bridge modules import no phaser', () => {
  it('each imports only koota, src/core and the other pure modules', () => {
    const pure = new Set(PURE.map((p) => resolve(game, p)));
    const bad: string[] = [];
    for (const path of pure) {
      const src = readFileSync(path, 'utf8');
      for (const m of src.matchAll(/(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/g)) {
        const spec = m[1];
        if (spec === 'koota') continue;
        if (!spec.startsWith('.')) {
          bad.push(`${path}: ${spec}`);
          continue;
        }
        const target = resolve(path, '..', spec.endsWith('.ts') ? spec : `${spec}.ts`);
        if (target.startsWith(core) || pure.has(target)) continue;
        bad.push(`${path}: ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

/**
 * Reference §3: the views read traits and call actions. So nothing under
 * src/game (nor main.ts) imports core's systems or kernels; the traits, the
 * actions, the schedule (the host runs it), the events, the rules and the
 * pure maths (projection, terrain, sweep) are core's public face.
 */
describe('src/game reads core through traits and actions', () => {
  it('no file under src/game imports core/systems or core/sim', () => {
    const bad: string[] = [];
    const files = [...walk(game), resolve(here, '../src/main.ts'), resolve(here, '../src/random.ts')];
    for (const path of files) {
      const src = readFileSync(path, 'utf8');
      for (const m of src.matchAll(/(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/g)) {
        if (!m[1].startsWith('.')) continue;
        const target = resolve(path, '..', m[1]);
        if (target.startsWith(resolve(core, 'systems')) || target.startsWith(resolve(core, 'sim'))) bad.push(`${path}: ${m[1]}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

/**
 * port_v2 phase 2: "the player" is the one whose turn it is ($7E:1803), and
 * code reaches it only through `activePlayer` / `findActivePlayer`
 * (core/traits/player.ts) — never by querying for a trait the player
 * entity happens to carry, which stops meaning "the player" once there are
 * two (2P) or once abilities add traits.
 */
describe('the player is reached through its handle', () => {
  const ON_PLAYER = [
    'BallPos', 'BallVel', 'BallAir', 'BallSpin', 'BallMode', 'BallHoled', 'BallHeading', 'StillCount', 'Modifier',
    'BallWork', 'Pose', 'BallScreen', 'BallSprite', 'Tomatoes', 'Strokes', 'Stars', 'StockedAbility',
  ];
  const lookup = new RegExp(`queryFirst\\(\\s*(?:${ON_PLAYER.join('|')})\\b`);
  it('no file under src or test calls queryFirst on a player trait', () => {
    const self = fileURLToPath(import.meta.url);
    const bad: string[] = [];
    for (const path of [...walk(resolve(here, '../src')), ...walk(here)]) {
      if (path === self) continue;
      const src = readFileSync(path, 'utf8');
      src.split('\n').forEach((line, i) => {
        if (lookup.test(line)) bad.push(`${path}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(bad).toEqual([]);
  });
});
