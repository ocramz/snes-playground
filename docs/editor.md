# The level editor: one hole, shared as a URL

`engine/editor.html` is a level editor for a single hole, with a playtest, on the engine ([engine.md](engine.md)). The level lives in the URL's hash, so a link is the whole level, and the page is a static site (`make editor-site`). Written 2026-11-16.

What a URL does:

| URL | goes to |
|---|---|
| `…/` (no `l=`) | the editor, on the default level |
| `…/#l=<payload>` | the level plays at once, with a play bar: **Edit**, **Retry**, **Copy link** |
| `…/#l=<payload>&edit` | the editor on that level: the editor's own URL, kept current as you edit, so a reload keeps the work |

**Share link** copies the `#l=` form, so whoever opens it plays first. The query flags of the engine still work beside the hash (`?debug`, `?nointro`). A link that does not decode opens the editor on the default level with a message. A level that decodes but fails the checks opens in the editor with its errors listed.

## Running it

```bash
make engine-editor        # the dev server, opening /editor.html (needs engine-assets and the rules)
cd engine && npm run editor
make editor-site          # build/editor-site/ (index.html, js/, assets/, rules/) and build/editor-site.zip
```

## The URL (`core/level/codec.ts`)

The payload, version 1, is base64url (no padding) of the `deflate-raw` compression (`CompressionStream`, native in browsers and in Node 22) of:

```
[1] [w] [h] [n] [name: n bytes] [shape: w*h] [elev: w*h] [walls: w*h] [tile: w*h]
```

- one byte per cell per layer, rows from the top, each from x = 0;
- the walls' low nibble only (`$80:8815`'s bits);
- a side is 4-32 cells;
- the name holds up to 24 characters of the game's font (`features/text/encoding.ts`), plus the underscore, which the font draws as a space.

Everything else is derived when the level loads, by `fromAuthoredCourse` ([engine.md](engine.md) "The hole flow and the actions"): the tee, the enemies, the occlusion table, the origin and the song (course 1's, `HOLE_SONG`).

Decoding refuses, with a `LevelDecodeError`:
- a payload that is not base64url or does not inflate;
- more than a 32 × 32 level's bytes once inflated (the inflate stops there);
- an unknown version, a bad size, truncated or trailing bytes;
- a shape above `$1B`, an elevation above 15, wall bits above the low nibble.

Measured (`test/level-codec.test.ts`, 2026-11-16):
- the default level's payload is 119 characters;
- the eight test holes' are 43-154;
- 20 generated holes (up to 24 × 24) stay under 1000;
- a 32 × 32 level of random bytes, the worst case, stays under 6000.

The share link of the default level is about 190 characters with the page's address.

## The corner model (`core/level/corners.ts`)

Every solid shape is four corner heights above the cell's elevation (NW, NE, SE, SW, in whole steps). Each edge's level in `$81:9310` (`terrainEdge`, half steps) is the sum of its two corners. All 27 solid shapes agree, measured on tables.json and checked by `test/level-corners.test.ts`.

| shapes | corners (NW NE SE SW) |
|---|---|
| `$01` flat, `$03` dimple | 1 1 1 1 |
| `$02` mound | 0 0 0 0, a bump in the middle |
| `$04` ramp falling N (`$05`-`$07` rotate it) | 0 0 1 1 |
| `$08` / `$10`, 3 corners up | 1 0 1 1 |
| `$0C` / `$14`, 1 corner up | 0 0 0 1 |
| `$18`, the full diagonal ramp | 1 0 1 2 |

One rotation (r + 1) maps (NW, NE, SE, SW) to (SW, NW, NE, SE).

So two cells meet flush when they share the corners of their common edge, and a hole's absolute corner heights (elevation + corner) are a height field on the grid's vertices, broken where there is a step.

`classify` turns four corners back into a cell. It subtracts their least, m, and reads the pattern:

| pattern | cell |
|---|---|
| all equal | `$01` at elevation m − 1; a flat top is 1-16 steps |
| one corner up | `$0C` + r at m |
| two adjacent corners up | `$04` + r at m |
| three corners up | `$08` + r at m |
| 0, 1, 2, 1 around the cell | `$18` + r at m |
| a saddle, or a jump of two along an edge | no shape |

Two refinements:
- A mound or a dimple stays one while its corners stay level.
- The faceted and the diagonal corner families share corners. A cell keeps its family, and a new corner takes the diagonal one only beside a `$18`-`$1B` ramp (the ROM's habit).

## The operations (`core/level/ops.ts`)

Each operation takes a level and a selection and returns a new level. The input is never changed, so the undo history (`src/editor/history.ts`, 200 deep) is the levels themselves. Each also returns a notice for what could not follow.

**Selecting** (`core/level/select.ts`):
- **Floor**: a click takes the floor section, the 4-connected cells whose four corners are all at the clicked cell's height. Shift adds.
- **Select**: drag a rectangle. Shift adds.

**Raise / Lower** (one step):
- **Slope mode** (the default): the selection moves one step, and so do the corners of the ring around it that met it flush, at its vertices. The ring is then re-shaped.
  - On flat ground, raising one cell is `HoleGrid.hill`, and lowering one is `HoleGrid.pit` (`test/level-ops.test.ts`).
  - A raised terrace drags the flush ground beside it into ramps, but not the ground across a cliff.
  - A ring cell whose new corners have no shape keeps its old one, and the step shows. Raising a terrace twice in a row hits this: its ramps would need a jump of two.
- **Cliff mode**: only the selection moves, and its border becomes steps.

Both refuse to leave elevations 0-15.

**The other operations:**
- **Blend**: the selection's vertex heights are taken from the unselected ground around it (the lowest where cells disagree) and interpolated in between (a relaxed Laplace solve). Each selected cell, gaps included, takes the shape of its corners. A gutter between two terraces becomes a flush ramp; a gap between them, a bridge.
- **Flatten**: flat at the selection's commonest top.
- **Dig**: gaps.
- **Fill**: the selection's gaps become flat ground, level with the highest edge of the ground beside them.
- **The shape brush**: any of the 28 shapes at an elevation.
- **Walls**: a click toggles an edge's wall. Walls are one-sided (the kernel tests the bit of the cell being left, `sim/edges.ts`), so an edge between two solid cells gets both bits, and an edge on a gap or the border gets the solid side's. **Fence** (`HoleGrid.fence`) walls every edge that faces a gap or the border; **Clear** removes them all.
- **Paint / Erase** a tile (the palette below), as a brush or over the selection.
- **Resize**: a row or column on any side, within 4-32. **Crop to the ground** cuts to the bounding box.

**When a cell's shape changes, its marking follows** (`palette.ts` `adaptTile`):
- the ice becomes `$20` + the ramp's fall direction, or `$24` on flat ground;
- a ramp's boost becomes `$34` + 2 × the fall direction, or the flat boost pushing the same way;
- the water becomes `$60` + the new shape.

Any other marking that no longer fits is removed, and the notice counts it. Actors are never moved; the checks report them.

## The palette (`core/level/palette.ts`)

The random holes' tiles (the ones the styled art draws and the solver plays, [engine.md](engine.md) "Random holes") plus the water. The brush refuses a cell a tile may not stand on and says why.

| group | codes | on |
|---|---|---|
| tee | `$0C`; painting it moves it | `$01` |
| ground enemies | `$40` `$4A` `$4B` `$4C` | `$01`, `$04`, `$05` (as the ROM's) |
| hovering enemies | `$4D` `$4E` `$50` `$51`; only a fly shot hits them | `$01`, `$04`, `$05` |
| tree | `$02` | `$01` |
| rough | `$04` | `$01` |
| ice | `$20`-`$23`; `$24` | the ramp of that fall; `$01` |
| boosts | `$30`-`$33`; `$34` `$36` `$38` `$3A`, pushing uphill | `$01`; the ramps `$04`-`$07` |
| kickers, arrows, snaps | `$10`-`$1B` (`$19` has no art). A kicker brakes a rolling ball and bends it toward its arrow, and does nothing to one rolling along it; a landing barely moves ([tiles.md](tiles.md) "Kicker") | `$01` |
| warps | `$B0`-`$B3`, one pair | `$01` |
| water | `$60` + the shape: `$61` open water, the rim `$64`-`$6F` | `$01`, `$04`-`$0F` |

The water bytes `$60`, `$62` and `$63` hang the ROM ([tiles.md](tiles.md) "Water") and are never written. A pond is a lowered floor section, flooded with its ramps: lower it in slope mode, then paint the water over it and its ring.

The editor offers no hazards, swirls, switches, outline tiles, other warp lists or copy-ability enemies. A level from elsewhere (the test holes' templates) may still hold them: they play, and the checks warn that the par is unverified.

## The checks (`core/level/lint.ts`)

**Errors** disable Play and Share:
- what `fromAuthoredCourse` rejects: no tee or two, fewer than two enemies, a tee off flat ground, an actor on a gap, a lone warp;
- more than 16 enemies (the enemy list `$69DE`);
- the cup `$08`, which is written in play and never authored;
- the water bytes that hang the game.

**Warnings:**
- placements the ROM never makes (an enemy off `$01`/`$04`/`$05`, the water not restating its cell's shape);
- more than 8 enemy species (the ROM's VRAM, `$82:B730`);
- markings on a gap;
- tiles outside the palette.

**Notes:**
- the snap `$19` has no art;
- the number of steps. The grid draws each step: amber for one step, red for more. A step up stops a rolling ball and a drop launches it, so steps are a design choice, not an error.

## The par

The random holes' solver (`core/gen/solve.ts`, [engine.md](engine.md) "Random holes") runs on the level in a Web Worker (`src/editor/solver.worker.ts`), 400 ms after the edits stop. An edit while it solves replaces the worker. The panel shows:
- **Par N**: the plan the solver found, which is not always the shortest (no spin, no A/Y);
- **Couldn't prove it winnable within the budget** (3000 shots or 80 states): it may still be;
- **Not winnable as far as the solver can tell**: an enemy is unreachable.

**Show the solver's plan** draws where the ball rests before each shot. The default level solves in 144 ms in node (par 3, 325 shots tried). The play page solves too, and the RESULT card shows the par once the solver has it. The par never blocks sharing.

**Water:** the generator never placed water, so the solver had not been checked on it. `test/level-play.test.ts` lowers and floods a pond with the editor's own operations. It then plays seven shots into it (grounders, fly shots, top and back spin), both silently on the solver's kernels and through the whole world. They rest on the same positions, and the pond's plan holes out. So the editor trusts the par on water (`lint.ts` `WATER_SOLVER_VERIFIED`).

## The editor's screen (`src/editor/`)

| file | does |
|---|---|
| `app.ts` | `LevelApp`: the modes (edit, play), the hash, Share, the play bar, the game's scenes |
| `editor-ui.ts` | `Editor`: the header, the tools, the palette, the shape brush, the par, the checks, the status line, the keys |
| `grid-view.ts` | the top-down grid and its pointer tools |
| `iso-view.ts` | the isometric preview |
| `sprites.ts` | the game's pictures for the canvases |
| `solver.ts`, `solver.worker.ts` | the par worker |
| `history.ts` | undo and redo |
| `editor.css` | the page's style |

**The grid**: x right, y down, N up.
- Each cell is drawn as its four quadrant triangles, coloured by height (the hue turns 32° a step, so neighbouring heights always differ) and lit from the NW, so ramps read as gradients.
- Each cell also shows its top's height, and an arrow down a ramp.
- Walls are bars along their edges; steps are coloured edges; the water is tinted.
- Actors are the atlas's pictures (the tee pad, the tree, each species' first idle frame, a hover badge); markings are glyphs.
- The wheel zooms; a right or middle drag pans.

**The isometric preview** is the styled rasteriser's picture of the level ([engine.md](engine.md) "Random holes"), redrawn 150 ms after the edits stop, with the actors at the views' points (`bridge/placement.ts`). A click centres the grid on the cell under the pointer. In node, the default level rasters in 5 ms and a full 32 × 32 level in 51 ms.

**Keys** (in the editor only):

| key | does |
|---|---|
| `1`-`6` | the tools: Floor, Select, Paint, Erase, Walls, Shape |
| `+` / `-` | raise / lower |
| `B` | blend |
| `F` | fill |
| Delete | dig |
| Esc | clear the selection |
| Ctrl+A | select all |
| Ctrl+Z / Ctrl+Shift+Z | undo / redo |
| `P` | play |

**New…** offers:
- the default level;
- an empty fenced island;
- a random layout (`buildHole`, the generator without its solve);
- the eight test holes of `engine/courses`.

## Play and edit on one page

The game is the engine's (`bootGame`, which now returns the host too), with `LevelMenuScene` (`game/scenes/level-menu-scene.ts`) as its menu. The page's app talks to the scene through `host.level`.

**Play** follows `RandomMenuScene.play`:
1. `fromAuthoredCourse` builds the hole, in a one-hole course set (`levelCourseSet`).
2. The save is off: `Save.member` = −1.
3. `startCourse` runs, then the Hole scene starts. The hole is drawn by the styled terrain, like the test holes.

**While the editor is up**, the game idles in the menu scene:
- its canvas is hidden and its loop asleep (`game.loop.sleep`);
- its keyboard manager is disabled. Phaser cancels the keys it captures (the arrows, Space) only while the manager is enabled, so the editor's inputs get them back.

**Every way out of a hole comes back to the menu scene**: the RESULT card's Enter or Esc, the pause menu's QUIT, the flow's Idle. There:
- **ENTER** plays the level again;
- **E** opens it in the editor.

The play bar's buttons keep the focus off themselves, so Space and Enter stay the game's.

**Edit** after a played link opens the level with a fresh history. After Play from the editor, the history goes on: Ctrl+Z undoes the last edit.

## The water in the styled terrain

`rasterTerrain` (`features/layers/styled.ts`) draws the water now, for the levels and for any hole without bitmaps:
- **Where:** over the part of each `$61` / `$64`-`$6F` cell that the region test `$82:83DD` does not call dry. `waterWet` duplicates `sim/water.ts`'s `waterRegion`, which the view may not import, and `test/styled.test.ts` checks the two agree on a grid of fractions for every byte.
- **Height:** a plane at the level `$82:83B9` (the cell's elevation, + 1 on `$61`, + `$57AD`).
- **Colour:** the flat patch's dark and light checks recoloured to the pond's two colours. Those were measured on course 1 hole 7's art (`holes/006/layer_front.png`, the open water at (8, 9) and its rim): (49, 132, 123) and (156, 239, 231).
- **Off:** none while the water switch has the water off at the load (`$5D` and no `$5C`, `$82:BC59`).

The ripple does not animate.

Course 1's redraw from its grids now matches its own art on 93.5 % of hole 7's pixels and 91.8 % of hole 8's (90.4 and 88.0 % without the water). Hole 8's reference now includes its `layer_front_water.png`, the water switch's layer, which is on at the load.

## The site (`make editor-site`)

1. `tools/stage_editor_site.py` copies from `build/engine` into `build/editor-site-public` only what the page loads:
   - `rules/tables.json`;
   - the top-level assets (the sprites, objects, ui, hud, card, pause and look pictures, the font, the cutscenes, the course art's patches);
   - every sound effect;
   - the songs a level requests, ogg and mp3: `LEVEL_SONGS` = 11, 17, 18, 24, 25, 26 (the event table's songs less the ROM holes' own; `test/level-site.test.ts` checks the list);
   - `holes/000/layer_bg3.png`, course 1's scenery.

   It rewrites `audio.json` and `manifest.json` to list only those. The manifest keeps course 1 with hole 0 alone, which is what makes the preload load the scenery.
2. `vite build -c vite.site.config.ts` builds `editor.html` alone into `build/editor-site`:
   - `base: './'` gives relative URLs (the asset keys already prefix `BASE_URL`), so the folder works served from any path, a GitHub Pages project site included;
   - Vite's chunks go to `js/`, apart from `assets/`.
3. The page becomes `index.html`, an empty `.nojekyll` is added, and the folder is zipped to `build/editor-site.zip`.

Measured on 2026-11-16: 202 files, 7.7 MB (5.3 MB zipped). The JavaScript is one 1.7 MB chunk (464 kB gzipped) and the worker's 101 kB. The page fetches one format of each sound.

**The site holds ROM-derived files:** the physics tables, the sprites, the course art, the sounds and the songs. CI cannot build it without the ROM. Publishing it is the user's decision, and nothing here pushes it anywhere.

## Verification

- `make engine-test` runs the node tests:
  - `test/level-corners.test.ts`: the corner model against `terrainEdge`; `classify` inverts every shape at every elevation.
  - `test/level-ops.test.ts`: the hill and the pit; raise and lower undo each other; slope mode leaves no step, and cliff mode steps the whole border; blend bridges a gutter flush; floor select, dig, fill, flatten, walls, resize and crop; the palette's placements and adaptations; the default level is clean.
  - `test/level-codec.test.ts`: the round trips, the lengths, the damaged links, the hash.
  - `test/level-play.test.ts`: the default level through the URL codec, the pond, and the water shots.
  - `test/level-site.test.ts`: the staged songs.
  - `test/styled.test.ts`: the water's extent and colours.
- `node test/e2e/editor.mjs` (in `npm run e2e`) runs against the dev server, or against the site with `ENGINE_URL=http://host/path/ EDITOR_PAGE=`. It checks:
  - the editor opens on the default level, with a par;
  - a rectangle raised and an enemy painted through the UI;
  - the URL `#l=…&edit`;
  - the share link plays that level (`__engine.phase()` reaches Aim), and a shot rolls the ball;
  - Edit brings the same level back, the game hidden;
  - Play from the editor;
  - the pause menu's QUIT, then E, back to the editor with the undo history intact;
  - a damaged link opens the editor with a message;
  - no page error, console error or failed request.

  On 2026-11-16 it passed against the dev server, and against `build/editor-site` served under `/snes-playground/` by `python3 -m http.server`.
- With `?debug`, `window.__level` exposes `mode()`, `json()`, `lint()`, `par()`, `selection()`, `shareUrl()` and `cellPoint(x, y)` (a cell's centre on the page).
