# Test courses

Eight authored holes in the engine's own format, played by the test suite
(`test/courses.test.ts`, `test/hole-flow.test.ts`) and, from phase 7, by the
dev build alongside the shipped ROM holes. Parsed and validated by
`fromAuthoredCourse()` in `src/core/course-data.ts`; laid out by
`tools/engine_courses.py` (rerun it after editing a layout there, or edit the
files by hand).

| hole | exercises |
|---|---|
| t1-flat | flat ground fenced by walls, three enemies, the cup, holing (the event-timeline test) |
| t2-ramps | ramps `$04-$07`, faceted corners `$0C-$0F` (a hill) and `$08-$0B` (a hollow), mound `$02`, dimple `$03` |
| t3-diagonals | diagonal corners `$14-$17` (a hill) and `$10-$13` (a hollow), full diagonal ramps `$18-$1B` |
| t4-steps-walls | terraces at elevations 0, 1, 3 (steps up block, steps down launch), a fence of layer-4 walls |
| t5-islands | two islands, open edges: a fall loses the ball |
| t6-surfaces | friction `$20-$24`, rough `$04`, boost `$30-$3B`, kickers `$10-$13`, snaps `$18-$1B`, arrows `$14-$17`, a warp pair `$B1`/`$B3` |
| t7-hazards | the hazard tiles (`$80`, `$98`, `$90`, `$AC-$AE`, `$05`, `$A2`) and pillars `$02` |
| t8-outline | an octagon of outline walls `$28-$2D`, hovering enemies (`$4D`, `$50`, `$51`) |

## Format

```json
{
  "name": "t1-flat",
  "about": "what the hole exercises",
  "w": 10, "h": 8,
  "shape": ["01 01 01 01 01 01 01 01 01 01", "..."],
  "elev":  [".. .. .. .. .. .. .. .. .. ..", "..."],
  "walls": ["09 01 01 01 01 01 01 01 01 03", "..."],
  "tile":  [".. .. .. .. .. .. .. .. .. ..", "..."],
  "originY": 184
}
```

- Each layer is one string per row (`h` rows), cells as two-digit hex bytes
  separated by spaces (`w` per row); `..` is `00`. `elev`, `walls` and
  `tile` are optional (all zero).
- The layers are the ROM's (docs/terrain.md, docs/tiles.md):
  - `shape`, layer 1: `00` gap, `01` flat, `02`-`1B` the other shapes;
  - `elev`, layer 3: the cell's base elevation, `00`-`0F`;
  - `walls`, layer 4: wall flags on the N/E/S/W edges (bits 0-3);
  - `tile`, layer 2: the special tiles.
- Nothing else is declared: the tee is the one `0C` tile; the enemies (tiles
  `40`-`52`), pillars (`02`) and hazard actors come from the load-time sweep,
  in its order; an enemy's hover height comes from its tile (`4D` 3, `4E`
  1, `50` 4, `51` 2, others 0).
- `originY` (the projection's row origin, `$8B9E`) and `screenBase` (`$8B9A`)
  are optional; the default fits the grid below the top of the bitmap.

Validation rejects, with the offending cell:
- a layer of the wrong size, or a cell that isn't a hex byte;
- a shape above `1B` or an elevation above `0F`;
- no tee, or a second one, or a tee not on flat ground;
- fewer than two enemies (one is taken, the last becomes the cup);
- an enemy that gives a copy ability, or the roulette `57` (copy abilities
  are deferred);
- an actor tile on a gap;
- a warp list (`B0`-`B3`, `B4`-`B7`, `B8`, `B9`) that is neither empty nor
  a pair (the game picks among 3 or 4 at random, which is not ported, and
  hangs on 1), or a warp on a gap.
