# Random holes: `engine/random.html`

**Status (2026-11-15): implemented**, phases 0-6; what was built is in
docs/engine.md "Random holes". Where it went otherwise than planned:
- the solver is best-first, not breadth-first: the fewest enemies left first,
  then the fewest shots, then the nearest free enemy. Breadth-first spent its
  3000 shots on the first two plies, and solved almost no hole. Par is
  therefore the length of the plan found, not always the shortest;
- the warp is simulated exactly through a hook `runKernelStep` now takes, not
  stood in for by a graph edge;
- `?debug` exposes `window.__random` (seed, holes, plans) rather than
  `__engine.gen()`, and there is no in-hole "regenerate" key: N in the menu
  draws a new seed;
- the style keeps a marking seen only once (the warps, snap $18 and $1B, the
  boost $37), and leaves out cells with walls: the ROM draws a wall as a line
  in the outline colour, which the renderer draws itself from layer 4;
- phase 0 measured 0.77 us a kernel step in node, so generation stays on the
  main thread, in 10 ms slices.

## Context

The question: can we build random new holes from the assets and mechanics extracted so far? **Yes.**

- **Gameplay.** The engine already plays holes that aren't from the ROM. `engine/courses/*.course.json` is a hex-grid format (shape, elev, walls, tile). `fromAuthoredCourse` (`core/course-data.ts:193`) validates it, and `features/layers/procedural.ts` draws it. Anything that emits this format runs on every mechanic the engine ports.
- **Art.** ROM holes draw from pre-built BG1/BG2 tilemaps (bank `$88` tables 8 and 9). A new geometry has none, but measurements this session show the art is very regular:
  - every clean interior flat cell, in all 116 geometries, is the same 8×4-tile BG1 block (tiles `$020`/`$021` with flips, palette 7);
  - cells sit exactly on the 8×8 tile grid;
  - all holes share one 848-tile page and one palette (water and boost holes swap tiles `$180-$1AB`);
  - floor markings (arrows, boosts, friction, warps) are BG2 overlays drawn over a plain BG1 ground.

  So a renderer can cut **exemplar patches** from ROM holes and stamp them per cell.

The user's choices:
- a **new entrypoint `random.html`** with matching npm and Makefile targets;
- **physics-checked** holes, so every enemy is reachable;
- **game-styled procedural** art.

## Facts the generator must respect
(From the docs plus statistics over the 116 ROM geometries and 212 tile layouts.)

- **Edges.** An edge's level is `2·elev + terrainEdge[shape][d]` (`RomRules.terrainEdge`, `core/rules.ts:70`); 0 is flush, > 0 blocks, < 0 is a drop.
  - A ramp cell takes the **upper** terrace's elevation and falls toward the lower one: lower side N gives `$04`, E `$05`, S `$06`, W `$07` (`tools/engine_courses.py:60-71`).
  - ROM ramps join flush at both ends, or open onto a gap.
  - Wall bits are never on flush or step-up edges. Falling off is normal: 157 of 212 layouts allow it.
- **Actors** stand only on shapes below `$10` (`$82:B477` has 16 entries). Enemies go on `$01/$04/$05`, trees, bumpers and volcanoes on `$01`.
- **Tile placement.**
  - Friction `$20-$23` only on the ramp of the same direction; `$24` on flat.
  - Boosts `$34-$3A` only on a ramp, pointing uphill.
  - The tee on `$01`, usually at elevation 1.
- **Enemies.** 3–4 per layout is typical. The **cup is whichever enemy is left last, in the player's order** (`take.ts:61-66`), so every enemy has to be reachable. A rolling ball never hits a hovering enemy (`$4D-$52`), so those need fly shots.
- **Reach at full power on flat ground:** about 14 cells for a grounder, about 7 for a fly shot.
- **Not usable.** Stubbed groups: `$58-$5D`, water `$60-$6F`, toggles `$70-$7B`. The validator rejects ability enemies and `$57`. Moving hazards can't be simulated on kernels alone, so v1 has none.
- **Fidelity note.** The cross-cell crest `$81:980B` isn't ported. For generated holes the engine's own physics is the reference.

## Design

### 1. Generator: `engine/src/core/gen/` (pure; `no-phaser-in-core.test.ts` already covers `src/core`)
- **`rng.ts`**: sfc32, seeded from a 32-bit number. Never `Math.random`.
- **`grid.ts`**: `HoleGrid`, a port of `engine_courses.py`'s `Hole`: `put`, `rect`, `gap`, `fence`, `hill`, `pit` (without the 5×5 rect or the entry ramp), and `toJson()` → `AuthoredCourseJson`. Also `edgeDeltas(rules)`, which returns signed mismatches. Every mismatch must be on the list of intended step-downs.
- **`layout.ts`**: a slot lattice with gutters, legal by construction.
  1. Slots are S×S (S = 4–5) on a pitch of S+1, so `w, h = C·(S+1)−1`.
  2. The path is a self-avoiding walk of 3–6 slots, plus at most one branch. Elevation starts in [1, 4] and changes by 0, ±1 or −2 per slot.
  3. The gutter between consecutive slots is one of:
     - flat, if the slots are level;
     - a ramp row at the upper elevation, if they differ by one step;
     - flat at the upper level, if the next slot is 1–2 steps lower: a deliberate step-down.

     A gutter is never a step up of 2 or more. Unused gutters are gaps.
  4. Variety:
     - `hill` and `pit` and mounds inside slots, with a 1-cell margin;
     - merged 2×1 slots, and partial doors (2–3 cells wide);
     - diagonal `$18-$1B` staircases (phase 3).
  5. Fencing is `fence()`, with per-difficulty odds of leaving rim edges open.
- **`features.ts`** (phase 4) adds only ported groups, each with its placement rule: rough `$04`, friction, boosts, kickers `$10-$13`, arrows `$14-$17`, snaps `$18-$1B`, trees `$02`, and one warp pair `B0-B3` whose exits face ground.
- **`place.ts`**: the tee on an empty `$01` cell; 2–5 enemies chosen from `enemyAbility` = 0 (`40, 4A-4E, 50, 51`), mostly non-hovering, spread along the path. The draw follows ROM priors: nearest enemy about 3 cells from the tee, farthest about 9.
- **`solve.ts`**: a kernel-level shot simulator plus a plan search.
  - **Context.** `{ rules, course }` with `presentation` **unset**. `false` would hide enemies, friction and boosts (`dispatch.ts:42,103`). `layer2` is a copy, as in `actions.ts:139-143`.
  - **Tee node.** `emptyWork()` at the tee: fractions `$8000`, `air = 0`, `probe`, `z = ground` (`actions.ts:148-155`). Every later node is a `cloneWork` snapshot taken at rest.
  - **Per shot**, mirroring `hole-flow.ts:311-316` and `panel.ts:156-200`:
    - reset `lost = fellOut = 0`, `fallTimer = $F0`, `over = frames = 0`, the modifier, `mode = 0`, `shotAim`, `shotElev` (0 or 60);
    - call `shotPower`, `shotSpin(…,6,6,P)` and `launchVelocity`, and set `air = fly`;
    - keep the latches, `stillGate`, `wallCode` and the probe fields.
  - **Per step:** set `w.scratch = w.deg`, run `runKernelStep`, then `countStill`. Then:
    - log `enemyHit`;
    - stop on `over` (rest), on `lost & 1` or `air && z < 0` (lost), or on `holed ≥ 1`;
    - cap at about 1200 steps.
  - **Warps.** Add an optional hook to `runKernelStep` (`ball-step.ts:471`) at the warp slot (`:257-264`). The solver's hook calls the pure `warpDestination`, `warpTeleport` and `warpExit` (`sim/warp.ts:111-150`).
  - **Cup.** When the second-to-last enemy is hit, write `$08` into the solver's `layer2` copy and clear `enemyLatch`.
  - **Search.** BFS over (rest cell, enemies-taken mask, tomatoes). Tomatoes start at 4 (also the maximum), cost −1 per shot and gain +1 per take; a state at 0 is dead.
    - Shots per node: targeted shots (`aimToward`, `sim/aim.ts:139`, at 0 and ±2°) at grounder meters {16, 28, 40, 63}, plus fly {40, 63} for hovering enemies; and an exploration fan of 24 aims × {24, 44, 63} plus 8 fly shots.
    - Budget: 40 nodes or 4000 shots.
    - The result is the shot plan, and **par** is its length.
  - Written as a `function*` that yields after each shot, so callers can time-slice it.
- **`generate.ts`**: `generateHole(rules, seed, opts)` runs layout → place → features → `fromAuthoredCourse` → `edgeDeltas` → solve. On failure it retries with `seed+k`. `generateCourse(rules, seed, n = 8, difficulty)` is also a generator.
  - `GEN_VERSION` goes into the label, because a seed's holes change if the physics changes.

### 2. The `random.html` entrypoint
- `engine/random.html`: a copy of `index.html` with `<title>Dream Course — random</title>` and `src="/src/random.ts"`.
- Move `main.ts`'s game construction into `src/game/boot-game.ts` as `bootGame(menuScene)`.
  - `main.ts` passes `MenuScene`.
  - `random.ts` passes `RandomMenuScene`, registered under **`SceneKeys.Menu`**, so Preload (`:123`), Hole (`:258`) and Result (`:58`) hand back to it unchanged.
- `src/game/scenes/random-menu-scene.ts`:
  - shows `RANDOM COURSE`, the seed, the difficulty, and `GENERATING n/8 (hole k: shots …)`;
  - drives `generateCourse` from `update()` with about 10 ms of work per frame;
  - when done, builds `host.set = randomCourseSet(holes, seed)`, runs `startCourse`, launches Hud and starts Hole;
  - back from Result: Enter replays the same seed, N picks a new one, and the up and down arrows change the difficulty.
  - The seed is written to the URL with `history.replaceState`.
  - If generation turns out too slow, move it to a Vite worker (`new Worker(new URL(...), {type:'module'})`, sending tables.json across). Phase 0 measures this first.
- `game/assets/course-sets.ts`: `randomCourseSet(holes, seed)` → `{ id: 'random', label: 'RANDOM <seed>', holes }` with `layersOf: null`. Widen the `id` union.
- `game/host.ts` `readFlags`: add `seed` and `difficulty`. `nointro`, `debug` and `hole` keep working. `?debug` adds `__engine.gen()` (seed, par, the plan).
- `engine/vite.config.ts:16`: add `random: resolve(here, 'random.html')` to `rolldownOptions.input`.
- `engine/package.json`: add `"random": "vite --open /random.html"`, and make `e2e` also run `test/e2e/random.mjs`.
- `Makefile`:
  - `engine-random: $(ENGINE_NODE) $(ENGINE_RULES) $(ENGINE_ASSETS)` runs `cd engine && $(NPM) run random`;
  - add it to `.PHONY` and `make help`;
  - add `engine/random.html` to `ENGINE_SRC`;
  - the style export joins the `$(ENGINE_ASSETS)` recipe.

### 3. Game-styled renderer (exemplar patches)
- **New `tools/terrain_style.py`.** It reuses `coursemap.py`'s `unpack`, `hole_page`, `hole_palette` and `blit`, and does not touch the uncommitted `export_web.py`.
  - For each shape `$01-$1B`: take the majority 8×6-tile block among interior instances whose neighbours all join flush, and render it to RGBA, 64×48 px, anchored at the cell's left vertex.
  - For each visible cliff face (E, the +x side; N, the −y side): take the majority tiles of one height step from clean drops.
  - For each marking tile id, on its shape: take the BG2 overlay block.
  - Output: `build/engine/assets/terrain_style.{png,json}`, recording for every patch where it came from (hole, cell, tile words) and how many instances agreed.
- **`features/layers/styled.ts`**: a pure software rasteriser. It is listed with the pure half of the bridge and has node tests.
  - It walks the cells back to front (`x − y`, the same order as `procedural.ts:90`).
  - Each surface pixel is tested against the cell's quadrant triangles, projected with `worldOf`/`surfaceZ`, and coloured from the shape's patch at the same offset from the cell anchor.
  - Cliff pixels down to the neighbour's surface, or to z = 0 over a gap, are coloured from the face tiles in screen space, which works because the 8-px grid is aligned.
  - Marking patches go on top, and layer-4 walls are drawn as a rim line.
  - A shape with no exemplar falls back to `procedural.ts`-style shading.
  - Output: a `Uint8ClampedArray` plus its origin.
- **`LayersView`** (a small edit on top of the uncommitted ripple work): when `layersOf === null` and the style has loaded, it puts the raster in a canvas texture as one Image at the `back` depth. It also draws course 1's `layer_bg3.png` and back colour as the backdrop.
  - Key D under `?debug` still switches to the schematic.
  - The test holes get the styled look too.
  - Preload loads `terrain_style.*` only if the files exist; otherwise everything falls back to the schematic.

## Phases (smallest playable slice first)
0. `plans/random_holes.md` (this plan). A timing test of the kernel loop decides between the main thread and a worker.
1. `core/gen` rng, grid, flat-only layout and placement, no solver. `random.html`, `RandomMenuScene`, the npm and Makefile targets. Playable with the schematic look.
2. `solve.ts`, the warp hook, time-sliced generation, and `test/gen.test.ts`.
3. Terrain variety: ramps, step-downs, hills, pits, mounds, staircases, open edges, the difficulty knob.
4. Features and hovering enemies.
5. The styled renderer: `terrain_style.py`, `styled.ts`, the `LayersView` hook, the backdrop.
6. Docs:
   - `docs/engine.md` gets a "Random holes" section: generator, solver, approximations, entrypoint, and the uncovered limits (no moving hazards, no outline tiles, no water);
   - `docs/tooling.md` gets `terrain_style.py`;
   - the `CLAUDE.md` repo-layout line.

## Verification
- **`make engine-test`.**
  - `gen.test.ts`:
    - the same seed gives byte-identical JSON;
    - 200 seeds all pass `fromAuthoredCourse`, have only intended edge deltas, put actors on shapes below `$10`, and use only ported tile groups;
    - 20 seeds solve within budget;
    - for 3 seeds, the solver's plan is **replayed through the full world** (set the aim and elevation during Aim, time the meter like `CourseDriver.shoot`) and reaches HoleOut. That is the fidelity check.
  - `styled.test.ts`:
    - deterministic output;
    - flat cells match the `$020/$021` block exactly;
    - re-rendering course 1's geometries matches the ROM bitmaps on at least 90 % of terrain pixels. Report the figure.
- **`make engine-random`.** Open `/random.html?seed=42`, generate, and play a hole by hand. Reloading the same seed must give the same holes. Check N for a new seed, Enter for a replay, the Result → menu loop, and `?debug` key D.
- **`make engine-e2e`.** `test/e2e/random.mjs` (Playwright) opens `random.html?seed=42&nointro`, waits for the generation, presses Enter and plays one shot. It asserts there are no page or console errors and that the ball moves, and saves screenshots to `build/engine-test/random/`.
- `make engine` builds both pages into `engine/dist/`.
