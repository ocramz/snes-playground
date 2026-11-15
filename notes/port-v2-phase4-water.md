# port_v2 phase 4: the water `$60-$6F`

Date: 2026-11-15. Plan: `plans/port_v2_rest_of_game.md` §8 step 4. The
session plan is in `~/.claude/plans/let-s-do-phase-4-cozy-nygaard.md`.

Scope, decided with the user:
- the water's two handlers, exact and traced;
- the ability modes' branches, ported as read and left untraced;
- the presentation, traced:
  - the splashes and the bubbles (objects 53-58 and 67);
  - Kirby's wet palette;
  - the guide's pictures from the water;
  - the four sounds.

The results are in:
- docs/tiles.md "Water";
- docs/animation.md "The water's objects";
- docs/physics.md;
- docs/engine.md.

This note keeps the measurements.

## The read

The routines came from `tools/dis65816.py` with `--m16 --x16`:

| range | what |
|---|---|
| `$82:8000`-`$82:80F5` | the rolling handler |
| `$82:80F6`-`$82:8227` | the landing handler |
| `$82:8228`-`$82:864D` | the helpers |
| `$81:B0C4`-`$81:B19C`, `$81:B285`-`$81:B2C9` | the guide's water |
| `$81:AF82` | the guide zeroes the level at every step |
| `$85:8E5A`-`$85:8FFB` | the splash objects |
| `$85:E76B`-`$85:EA2E` | object 67 |
| `$80:87DD` | the random numbers |

Three things in the read were not obvious.

**The modifier's bounce stores the wrong factors.** `$82:82D4` loads
`$00` = `$82:833C,X` and `$02` = `$82:8340,X`. A is still `$02` when the
first multiply runs (`$82:82E3`). The second product (`$82:82EF`) is
overwritten by `LDA $02` before it is stored. The result:
- vx takes `$8340`'s factor (the z one);
- vy is unchanged;
- vz takes `$8340`'s factor, negated.

web_water_mod matches this reading, frame for frame.

**`$80:A367` returns the high word only for A ≥ `$8000`.** `$80:A378` is a
signed 16 × 16 multiply that returns A unchanged. `$80:A367` adds X to the
high word when A is negative, so for A ≥ `$8000` the result is
(A unsigned × X signed) >> 16. Every caller passes such a factor. With
A < `$8000` the routine would return A itself. The engine's `fixed.ts`
`mulHiU` covers only the case the callers use.

**The waits of object 67 read past their table.** `$85:E800` builds the index as
`$85:E875`[rng & 7] × 2 + 6 × toggle, then reads the byte table
`$85:E87D`. That table has six bytes (120, 240, 60, 60, 30, 15), so the
toggle's half runs into the code after it:
- index 6 reads `$B9`, from `LDA $531C,Y`;
- index 8 reads `$53`;
- index 10 reads `$45`, from `JSL $80:E445`.

So the waits alternate between {120, 60, 30} and {185, 83, 69} ticks.
tables.json `bubbleWait` keeps all eleven bytes.

### The region and the level

The region (`$82:83DD`) is a 16-way jump table. Entries 0, 2 and 3 (`$60`,
`$62`, `$63`) are `BRA $840E`, a hang. A tile outside `$60-$6F` hangs too
(`$82:83E7 BCS self`).

The tiles used over the 232 holes:

| tile | cells |
|---|---|
| `$61` | 505 |
| `$64` | 268 |
| `$65` | 215 |
| `$66` | 272 |
| `$67` | 219 |
| `$68`-`$6B` | 70-74 each |
| `$6C`-`$6F` | 8-12 each |

The 1P inner corners are on holes 22, 23, 27, 52 and 62.

On course 1 hole 7:
- the plateau is elevation 3, with its surface at 4 steps (`$1_6A08`);
- the rim ramps go from 4 steps to 3;
- the open water `$61` is elevation 2, a flat 3 steps (`$1_0F86`);
- the level is `$1_0F86` + `$57AD` = `$1_6733`, `$2D5` under the plateau.

### `$D9EE` is the block's `$D872`

| what | routine |
|---|---|
| load | `$82:F020` |
| store | `$82:F1B0` |
| the set-up copies it | `$80:C670` |
| the guide starts from it | `$81:A9D9` |
| the guide's rolling water tests it | `$81:B2A0` |
| the probe wrapper clears it | `$81:87FB` → `$82:C85F`, off `$60-$6F` or with `$69CA` set |

The engine's `overlayProbe` used to *set* `$D9EE` on every water tile. That
was harmless while nothing read the flag.

## The scenarios

All the scenarios are on course 1 hole 7 (index 6). It is picked at 2050
with `$6A5A` = 0, `$6A5C` = 0 and `$6A5E` = 6. The poked ones use web_snap's
A presses (2360/2437/2444) and poke the ball at 2468. The offset is 2332,
the first set-up `aim` (2334) − 2.

| script | the poke | what happens |
|---|---|---|
| web_water_roll | (10,9) on the plateau, z `$1_6A08`, vx −`$600` | 2496: onto the rim, air 1, vz 0. 2502: in the region, deep: v / 8 (−1207 → −150, −384 → −48), object 55, two 67s, palette wet, sound 0. 2503: `$49`, `$D872` = 1. Then the drag, the bed (2512 a bounce, 2523 rolling) and rest at (8,9). Shot over at 2656 |
| web_water_drop | over (8,9), z `$1_E733`, vz −`$1000` | 2481: deep, / 8 (−4544 → −568), object 57 with its 58, `$4C` |
| web_water_shallow | (9,8) xf `$E800`, z just above the level, vz −`$300` | the entry on the poke's frame: corner `$6A` shallow, / 2 (−768 → −384), object 56, `$4C` |
| web_water_skim | (10,9) xf `$4000`, vx −`$1200`, vz −`$100` | it lands on the plateau, rolls onto the rim, and skims (objects 54, 54, 54, then 53 under `$B00`), until it sinks |
| web_water_climb | the bed at (8,9), `$D872` = 1, vx +`$1400` | the drag up the rim. 2498: out of the region (x `$ECB5`): `$D872` 0, object 55, the dry palette, no sound. 2501: the rim's crest launches it (the unported cross-cell branch), where the window ends |
| web_water_skip / _back | over (10,9) z `$1_8000`, vx −`$800`, vz +`$100`, `$D866` = `$800` / −`$900`, `$6B58` = 0 / 12 | the count is 2 (`$69DC` at 2484). Two skips (object 54 and Kirby's state 14 at each). Topspin goes past the pond to the enemy at (6,9); backspin sinks on the third contact |
| web_water_mod | _back with A at 2545 | the third contact is the modifier's bounce: object 53, `$48` |
| web_water_shot | no ball pokes | a fly shot (UP, A 2420/2470/2500/2567) over the enemy at (11,9), which it takes, into the pond at 2761. The second set-up is at 2942. A fly shot out (UP 2990, A 3030/3080/3110/3142), through the surface at 3176. It takes (6,9) |

Two facts about the scenarios:
- **The lag after the poke.** Hole 6 lags about 5 frames after the poke. In
  the matched pairs the game frame minus the engine frame goes from 1 to 5
  at about 2474. The distinct-state alignment absorbs this.
- **web_water_mod's `$26`.** The A press's sound is input-driven, so the
  scenario compares it at the game's iteration, not carried through the
  ball states (`Scenario.uncarried`).

## The colours

Kirby's palette 0, from the CGRAM shadow `$7E:0500-$7E:051F` at
web_water_shot 2740 / 2850:

```
dry 2D6B 0C63 2C9C 453F 61DF 7A7F 7F5F 0C63 18E2 1CE7 35C4 4648 5AED 6B71 7BF5 7FFF
wet 2D6B 0C63 312F 45D4 5E76 72F8 7FBA 0C63 18E2 1CE7 35C4 4648 5AED 6B71 7BF5 7FFF
```

`$82:8604` writes seven colours (`$98:C796`, colour 7 `$294A`). The next
frame, `$84:9A38` writes colour 7 back to `$0C63`
(`--watch-write $7E:0500-$7E:0513`: 2760 line 253 `$80:90D4`, 2761 line 28
`$84:9A38`).

`$84:9A38` is a thread hook that sets Kirby's outline colour every frame,
from `$98:D4A8`[`$84:9DDB`[phase]]. X is 0, so the colour is `$0C63`,
whenever any of these holds:
- `$D872` is set;
- `$D852` is 0;
- `$D85E` < 0;
- `$D876` = `$8000`;
- Kirby's state is 10 or 11.

Otherwise the outline steps through 0C63 0982 06C1 03E0, a green flash. It
is unconfirmed which ability state drives the flash.

So on screen only colours 2-6 change. tools/kirbyanim.py `wet_palettes`
draws the wet twins that way. With the base snapshot's palette 0, the result
equals the game's wet palette exactly.

The splashes, the drops and the bubbles also draw with palette 0, but only
with its colours 8-15. Drawn in either palette they are the same pixels. The
shadow (object 121) uses colour 7/1 (`$0C63`).

The guide in the water draws different pictures with palette 0, in the wet
colours:
- the rolling dot `$89:8F52`, tile `$074`;
- the airborne dot `$89:8F39`, tile `$064`;
- the end `$89:8F6B`, tiles `$09F`/`$08F`.

The dry ones use palette 3 (the dots) and palette 1 (the end, player 1).

## The random numbers

`$80:87DD` is called from 31 sites. Over web_water_roll from frame 2100
(`--log-pc $80:87DD`), its callers are:
- `$84:B871`, 10 times, 2200-2236, in the hole's opening;
- `$85:E906` and `$85:E804`, the bubbles.

The aim loop's `$81:A875` is not reached in these runs (it sits behind a Y
test). The port `sim/rng.ts` matched all 50 calls of the run from the
power-on state (0701, 0001).

The tests seed `GameRng` from the recording at the set-up (trace_flow.py
`rnga`/`rngb`). Every bubble position and wait then matches, the bubbles
during the second aim included (from Kirby's head, by his facing).

In play the engine's random state starts at the power-on value and only the
bubbles advance it. The game's state also carries the menus, the attract and
the hole openings, so in play the bubbles are the game's in kind but not
draw for draw.

## The depth of the splash

ppu_render of web_water_shot 2763 shows splash 55 over Kirby's lower half.
Its OAM queue is Kirby's (no `INC A`). One queue back (53, and 54 after its
first frame) is drawn behind him.

The snap stars' snapshot check in phase 3 was a north push, so it had
queueAdd 1, which is consistent with this. The stars' queueAdd-0 case (for
a heading of 3-10) is drawn behind Kirby by the engine, and may be wrong in
the same way (unconfirmed).

## Other findings

- **Objects 56-58 were never on screen** in holes.py's two shots per hole.
  `holes.py --script NAME:FROM-TO` now adds snapshots of an input script to
  the same emusheets cache. With web_water_drop, _shallow, _skim and _roll,
  every frame of 53-58 and 67 has a sheet. Their pictures in the engine are
  drawn from the ROM's frame lists with a snapshot of the roll; the aim's
  OBJ page holds the shot panel's tiles where the splashes' are.
- **Object 25's stars.** The launch's ring of stars, object 25, is drawn at
  every fly shot (web_water_shot 2597 and 3166). The engine does not draw it
  (the `$6AC0` presentation spawn is deferred). It is not the water's.
- **The ability drop.** With an ability active (`$D9C6` 1-11), entering
  water drops it. Kirby's state code does this, not the handlers:
  `$82:CDC5` → `$82:D923` sets air 1, the gravity, `$D76C`++, state 19,
  `$DA6A`, mode and `$D9C6` 0, `$D9C2` 0; `$82:DE3B` → `$82:E1A7` does the
  same without the air. The engine keeps no `$D9C6`, so this is step 5's.
- **The tally** (the survey's appendix, 'overlay' out of PARITY):

  | holes | clean | course-1 level | blocked |
  |---|---|---|---|
  | 1P | 20 | 39 | 5 |
  | extra | 6 | 53 | 5 |
  | 2P | 4 | 7 | 21 |
  | demos | 9 | 10 | 1 |
  | 192-223 | 2 | 5 | 25 |

  Course 1 hole 7 (index 6) is clean. Hole 8 (index 7) keeps its `$5C`.

## Result

- `make engine-traces` re-records every fixture, the new ones included.
- `make engine-test`: 39 files, 565 tests.
  - trace-terrain: the eight scenarios, ball states and sounds.
  - water-fx: the palette and `$D872` per matched state; every splash and
    bubble; the kernels.
  - trace-script and flow: web_water_shot, the guide's ends over the water
    included.
- `npm run e2e` passes, with test/e2e/water.mjs, the shot frame by frame in
  the browser.
- `tools/check_web_ui.py --target engine` passes.

Not done:
- the ability drop on entering water (`$D9C6`, step 5);
- object 113's freeze (`$69CA`, step 6) and splash palette (`$69DA`, step 5);
- player 2's palette (`$98:C788`/`$C7A4` at CGRAM `$92`, step 9);
- water in the random holes;
- the outline colour hook `$84:9A38`'s flash;
- the hop's palette flash on `$0504` (`$5DFF`, web_water_mod 2548-2566). It
  is not the water's, and it is unported.
