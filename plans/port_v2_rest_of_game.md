# Survey: what is missing to port the rest of the game to `engine/`

Surveyed 2026-11-15. The starting point is `engine/` as described in [docs/engine.md](../docs/engine.md): the 1-player loop of course 1 (ROM holes 0-7), plus 8 test holes.

Sources:
- engine.md's own "Not ported", "Deferred" and "Unconfirmed" lists;
- a read of the subsystem docs for every screen and mode beyond the hole loop;
- a code audit of `engine/src`, the Makefile and the exporters;
- a per-hole feature tally over the 232 ROM holes (method and script in the appendix).

Claims marked **unconfirmed** are inferences, not measurements.

**The finding.** The hole loop is mostly porting work, but nearly everything around it is still reverse-engineering work. Almost every screen has been reached in the stepper and named by scene number, routine and song ([emulation.md](../docs/emulation.md), [scenes.md](../docs/scenes.md)). Their logic has not been read.

## 1. Where the 232 holes stand

The hole index is course×8 + hole (`$82:B0A4`, [courses.md](../docs/courses.md) "Indexing").

| indices | mode | clean | course-1 level | blocked |
|---|---|---|---|---|
| 0-63 | 1P courses 1-8 | 64 | 0 | 0 |
| 64-127 | extra game: the same terrain, a different layer 2 | 64 | 0 | 0 |
| 128-159 | 2P. Only Whispy Woods (128-135) has been run ([physics.md](../docs/physics.md) "The extra game and two players") | 13 | 0 | 19 |
| 160-179 | the 20 DEMOPLAY holes (`$88:C880`'s records; demos 10-19 on 160-169, played, [emulation.md](../docs/emulation.md) "The DEMOPLAY demos"). Each of MAPC0-MAPD1 holds exactly one ability species, and together they cover all ten abilities | 20 | 0 | 0 |
| 192-223 | a second layer 2 for MAP80-MAPB7; what selects it is unknown | 9 | 0 | 23 |
| 224-243 | stub layer 2: a lone `$0C` and no enemies, so no cup is possible | — | — | 20 |
| 184 | **unconfirmed**: Dedede's arena. physics.md puts the extra game's Dedede at 184. The slot holds the "shared filler" entry, whose header `$9F:EB41` is a real 16×16 hole named `MAPF0`. Not exported | | | |

The counts are after step 6 (the switches and the swirls, §8). After step 5 they were 57/2/5, 57/2/5, 11/0/21, 19/0/1 and 7/0/25; after step 4 20/39/5, 6/53/5, 4/7/21, 9/10/1 and 2/5/25; after step 3 17/42/5, 5/54/5, 3/8/21, 8/11/1 and 2/5/25; before it, with the snaps blocking, 15/30/19, 5/40/19, 3/6/23, 8/11/1 and 2/3/27.

The columns:
- **Clean:** every layer-2 tile goes through a ported handler.
- **Course-1 level:** the hole also uses what course 1 shipped with as a stub. Nothing is left since step 6.
  (Until step 4 the water `$60-$6F`, then plain ground, counted here too; until step 5 the ability enemies, whose take was ported but which granted nothing; until step 6 the water switch `$5C`/`$5D`.)
- **Blocked:** the hole has the `$58` switch or the roulette `$57` (until step 6 also the swirls `$70-$7B` and `$5A`/`$5B`; until step 3 the snap tiles).

Two things do not affect any hole:
- the warps' random pick: no ROM hole has a warp list other than 0 or 2 panels;
- an unported hazard actor: every actor `$82:BDBC` spawns is type 72, 73, 76, 77 or 81-83, and the engine ports all of them.

Not counted, because they touch every hole: the crest's cross-cell branches (`engine/src/core/sim/roll.ts:30-50`) and the game's lag frames.

### What blocks the 1P holes

| feature | 1P holes | engine | RE state |
|---|---|---|---|
| ~~snap tiles `$18-$1B`: the gate `$82:A692` and the exact clamps~~ | 14, all with no other blocker: 29, 32, 37, 39, 41, 45, 49, 50, 52, 54, 55, 57, 62, 63 | **ported in step 3**, with the star trail (objects 61/62); 29 and 37 are now clean, the other 12 course-1 level (water or ability enemies) | traced: web_snap* (docs/tiles.md "Snap panels") |
| ~~toggles `$70-$7B`, always with `$5A`/`$5B`~~ | 5: 10, 19, 25, 26, 43 | **ported in step 6**: the swirls and the toggles' switch, with object 127's tiles and object 117's colours | traced: web_sw_* (docs/tiles.md "Swirls", "The toggles' switch"). Settled: `$5A`/`$5B` flip `$6A2A`, which turns `$74-$77` on and `$78-$7B` off |
| ~~`$5A-$5D`~~; `$58`/`$59` | `$5A`/`$5B` in the 5 above; `$5C`/`$5D` in 2 (hole 7, which is course 1 hole 8, and 23); `$58` on the 2P holes 132-143 and 196-207 only | `$5A-$5D` **ported in step 6**, the water switch with its 64-frame dissolve; `$58` a stub | `$58`/`$59` read, not traced (tiles.md "Not established"), left for step 9 |
| ~~**water** `$60-$6F`~~ | 17: 6, 7, 12, 20, 22, 23, 27, 31, 32, 33, 35, 50, 52, 55, 57, 62, 63 | **ported in step 4**, with its splashes, bubbles and Kirby's wet palette; 6, 12 and 27 are now clean | traced: web_water_* (docs/tiles.md "Water") |
| ~~**ability enemies**~~ | 38 of 64. Per course: 3, 3, 3, 5, 6, 5, 7, 6. Course 1 has `$42` Parasol and `$48` Hi-Jump | **ported in step 5**: all ten abilities, the transformation, the HUD's icon, Kirby's colours, the objects | traced: demos 10-19, web_ab_* (§3) |

Over all 232 holes, water is on 45 (17 + 17 + 4 + 3 + 4 by the ranges above), which agrees with tiles.md.

## 2. The course-generic gaps: porting work, the data is mostly known

**Hole loading is fixed to course 1.**
- `engine/src/game/assets/keys.ts:66-80` has `ROM_HOLES = 8`, and `holes/0${h}` breaks from hole 10 on.
- `game/scenes/preload-scene.ts:73-120` loads holes 0-7 up front.
- `game/assets/course-sets.ts:24-53` knows only `'rom1' | 'test'`.
- The `Makefile:148-150` loop exports holes 0-7.
- Fix: key the holes by ROM index, read the course list from the manifest, and load one course at a time.

**The hole songs.** `HOLE_SONG` = 11 everywhere: `core/traits/flow.ts:51`, `core/systems/hole-flow.ts:173,238`, `course-sets.ts:40,51`. The game picks a song per hole: `$80:C967` reads a byte of the per-course list `$80:C99D`[`$6A5C`] ([audio.md](../docs/audio.md)).

The table below was read with `romcheck.load_rom()`:
- `$80:C99D` holds 28 word pointers into bank `$80`, each to 8 bytes.
- Each byte is a song request, `$7E` + n. For example, course 1's list is `89 89 89 89 85 85 85 8B`.
- That `$6A5C` = 2 × course was recorded only for courses 0-15.

| list | holes 1-8 |
|---|---|
| course 1 | 11 11 11 11 7 7 7 13 |
| course 2 | 6×7, 13 |
| course 3 | 11×7, 13 |
| course 4 | 14×7, 13 |
| course 5 | 10×4, 8×3, 13 |
| course 6 | 9×7, 13 |
| course 7 | 10 10 11 11 6 6 6 13 |
| course 8 | 12×7, 13 |
| 8-15 (extra) | as courses 1-8 |
| 16-19 (2P) | 7/10, 8/6, 11/9, 14/12: the first song for holes 1-4, the second for 5-7, then 13 |
| 20-23 | song 27 on all 8 holes |
| 24-27 | as 16-19 |

The work:
- Put the song on `CourseData`.
- Drop the intro replay's recorded song-11 cue (`game/features/cutscene/replay.ts:90-96`).
- Export the songs: `tools/web_audio_map.json` has 11, 17, 18 and 24-26 only, so songs 6-14 and the ability effects are missing.

**The enemy pictures.** Every enemy draws species `$4C`'s sheet, from the c1n recording (`features/enemies/enemy-view.ts`, `features/catalog-data.ts:24-27`).
- All 20 species occur in the 212 full layouts, and only 16 layouts use `$4C` alone.
- Which picture a type-73 subtype draws is decided inside type 73's code (tiles.md "Not established").

**Other per-course pictures.**
- The ripple's colours, `$84:84AF`[course]: `$98:E030`-`$E810` for courses 0-7, and `$98:E930` for courses 14-15. **Unconfirmed**, read by the survey; courses.md has the course-1 case. The engine ripples course 1's holes 7 and 8 only.
- The boost panels' palette cycle, object 112, on 20 holes. It is not in `engine/src`.
- The objects atlas: the engine draws only the first picture table of objects 77 and 81-83.
- The night palette exists for hole 1 only (`tools/export_web.py:594-597`), and its ROM source is untraced. **Unconfirmed** lead: the alternate tables `$80:D527` and `$84:84F1`, chosen by `$7E:6A2E`.

**The cutscenes.** The fly-in and the hole-outs are one recording of c1n's hole 1 (`replay.ts:55-58`), and no current tool can recreate it (Makefile, `distclean`). Either re-record them per course, or port the star objects as thread objects.

**The traces.** `engine/test/flow-harness.ts:42` pins `GAME_OFFSET` = 2332 to hole 1's scripts. A new script needs its own offset. Tests on another course also need its stepper scripts.

## 3. Copy abilities: done (step 5)

Ported and traced (notes/port-v2-phase5-abilities.md; [physics.md](../docs/physics.md) "Copy abilities"):
- **The ids** in the mode `$D85A` ↔ `$D9C8`: 1 Stone, 2 Parasol, 3 Fireball, 4 Needle, 5 Tornado, 6 Wheel, 7 Spark, 8 Hi-Jump, 9 Freeze, 10 UFO; 12-21 hit codes. The block pairs four words: the stock `$D852`, the worn `$D856`, the mode `$D85A`, the latch `$D85E`.
- **Which enemy gives which**, `$82:B6EB` by species (tile − `$40`, `tables.json` `enemyAbility`): `$41`-`$49` give 1-9, `$4F` gives 10 (not `$52`, which gives nothing), `$57` is the roulette (11, only on holes 131-159 and 193-223).
- **The use**: B mid-roll with a stock (`$82:C875`), the transformation's 48 frames, the setup and the per-mode air and ground handlers; the stock kept across shots and holes in 1P, the latch per shot.
- **The references**: demos 10-19 replayed from the ROM's streams (every ball state, Kirby's states, the sounds, Kirby's colours, the HUD's icon, the drawn objects), eleven poked scenarios and one take-and-use on course 1 (web_ab_c1).
- **The bugs found on the way**: the rough `$04` read the next table's words, the kickers' axes and signs, the crest's cross-cell branches (now ported), the rolling step hit's launch in modes other than 0 and 7, the take's two halves.

Left for step 9 (2P): the ball-to-ball hit codes 12-17, the contact matrix `$82:C41E`, the stock swap, the roulette `$82:8DD2`, Freeze's `$D780,X` = `$15`. Left in the presentation (docs/engine.md "Not ported"): the UFO's saucer and the parasol's canopy (overlays in Kirby's OAM pass), Kirby's frame index `$D95E`, objects 34, 42-45, 60, the power stage's glow.

## 4. Two players: a structural refactor plus RE

The engine assumes one player:
- `spawnPlayer` (`core/world.ts`) makes one entity that carries the ball and every counter.
- ~~`queryFirst(BallWork)` stands for "the player" at about 10 sites.~~ Done in step 2 (§8): every site goes through `activePlayer` / `findActivePlayer` (`core/traits/player.ts`), the `IsActivePlayer` tag standing for `$1803`. A turn change has only to move the tag.
- `Career` and `TomatoQueue` are world singletons (`core/traits/counters.ts:41,67`), but the game tags each queue entry with its player.
- `Pad` reads player 1 only.
- `HoleFlow` has no turn change.
- Not ported:
  - the 2P camera follow (`sim/camera.ts:89`);
  - player 2's priority call `$82:C0F7` (`sim/priority.ts:4`);
  - the warp's 2P wait (`systems/warp.ts:48`);
  - the star steal (`systems/take.ts:52`).
- Already 2P-ready: `TakenBy` is exclusive.

The game, known:
- the per-player block at X = `$1803` (`$82:F030`);
- the steal `$82:8B0F`;
- the ball-to-ball hits `$82:C693` → `$82:DB79` → reaction states 40-50;
- the 2P select screen (scene 6, `$83:D540`) and the handicap and dice screen (scene 12, `$83:DB4C`).

The game, unknown:
- the handicap and dice rules;
- the 2P HUD;
- the indices of the other three 2P courses;
- what selects 192-223;
- in the one recorded run, player 2 never scored.

## 5. King Dedede: mostly RE

Known (physics.md "King Dedede"):
- `sub_final_stage $87:E767`;
- his HP, `$ED2D` = 24;
- the hit box `$87:EEEE`;
- the damage by height, `$87:EF88`, halved in the extra game (`$87:878E`, `$EAB9`).

Unknown:
- his movement and attacks: `$ED2F`-`$ED39` are only the box;
- the losing exit `$87:88C2`/`$87:8B9B` (unconfirmed);
- the arena: index 184 is not exported.

## 6. The game shell: screens reached, logic unread

The engine has:
- a menu: course 1 or the test holes;
- the whole course's card;
- GAME OVER and CONTINUE;
- the HUD.

Every screen below has been rendered from the stepper (`build/screens`).

| screen | scene, routine | still unknown |
|---|---|---|
| the per-hole RESULT card | `$83:D3ED`, no scene request (scene 3 is the ranking entry's card, `$81:F92B`) | **ported in step 7** ([flow.md](../docs/flow.md)) |
| pause; B (the spin preset, not an overview); Y (the look); SELECT (the mid-course card); the aim's L/R snap and B cancel | `$83:AFA7`, `$83:B214`, `$81:B9A2`, `$81:BCB6`, `$81:B6C3`, `$81:C089` | **ported in step 7** |
| the course map, the course intro | scene 5 `$83:9690`, scene 11 `$86:FD0B`; the cleared courses `$7E:D7BE` from SRAM (`$81:FB9C`) | the cursor, the advance animation |
| the course result, the ranking, the medals | scenes 8, 4 and 15 (`sub_medal_award $83:F985`); the medals at `$70:021A` | the score (the strokes' total) and the medal thresholds (`$81:C735`) are read; the screens' animations (objects of banks `$84`/`$85`) are not |
| SRAM | 8 KB, mapped ([save.md](../docs/save.md)) | **read in step 7**; the engine keeps it as JSON. The drawings' format is unread (NAME ENTRY is skipped) |
| the logo, the title, the attract demo | scenes 16 and 1; the title map `$92:8550` | which hole the attract plays, its input source |
| the title menu, the hidden items | gates `$7E:EAA9`-`$EAB3` (`$81:C7AF`); MAP SELECT, SOUND ROOM, DANCE SELECT | the menu logic |
| the name entry (a drawing pad) | scene 2, `$81:DFD9`, the zones `$81:E0C7` | how a drawing is stored |
| DEMOPLAY | scene 13, 20 demos | read and played for 10-19: the records `$88:C880`, the stream `$83:DAAA`, holes 160-179 ([emulation.md](../docs/emulation.md)); the menu itself is unported |
| the ending, the credits | scenes 18 and 19 | the sequence, the credits text |

## 7. Doc discrepancies to fix

- **[scenes.md](../docs/scenes.md) "The BG3 layer", "each of the eight courses has a distinct theme": wrong.** In all three of the per-course tables, entries 1 and 4 are identical, and so are entries 2 and 6. That leaves 6 distinct sceneries. Verified with `romcheck.load_rom()` at file offsets `0x5748` (tiles), `0x5768` (map) and `0x5517` (palette):

  | table | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
  |---|---|---|---|---|---|---|---|---|
  | tiles `$80:D748` | `$90:A836` | `$90:B1B2` | `$90:ED83` | `$91:AD5B` | `$90:B1B2` | `$90:9494` | `$90:ED83` | `$90:E5E1` |
  | map `$80:D768` | `$92:8000` | `$8E:FB5F` | `$91:E7A2` | `$91:A0CD` | `$8E:FB5F` | `$91:E20F` | `$91:E7A2` | `$92:B347` |
  | palette `$80:D517` | `C290` | `C3D0` | `C330` | `C2E0` | `C3D0` | `C380` | `C330` | `C5E0` |

  The alternate palette table `$80:D527` pairs the same entries.
- **[tiles.md](../docs/tiles.md) lists `$1C`/`$1D` as "not established".** The engine ports them from the disassembly as the rough family `$82:9342`/`$82:938E` (`engine/src/core/sim/dispatch.ts:238-253`), and engine.md says no trace exercises them. The two docs need reconciling.
- **[courses.md](../docs/courses.md) "Indexing" calls the unpopulated slots a "shared filler entry".** Its header is a 16×16 hole, `MAPF0`, likely Dedede's arena (§1). Re-measure before editing.
- **The `$87:EB44` graphics are listed as belonging to an unreached screen** ([compression.md](../docs/compression.md), [emulation.md](../docs/emulation.md)), reachable only through the jump table at `$87:8B85`. That table sits next to the final-stage code, so the note is probably stale now that the whole game has been played. Re-check it.

## 8. Recommended order

Ordered by holes unlocked per unit of RE:

1. **Generalise the hole loading per course** (§2): the hole keys, the song table, the species sheets, the ripple's colours, object 112. This is pure porting. It makes 15 1P holes play exactly and 30 more at course-1 level.
   - **Done 2026-11-15** ([notes/port-v2-phase1-courses.md](../notes/port-v2-phase1-courses.md); docs/engine.md). Courses 1-8 are exported under `holes/NNN` and loaded one course at a time. Each hole has its song, each species its recorded idle clip, and each hole the CGRAM in play with its palette cycles (objects 111-115). Also ported: the hazards' frame tables by tile, and object 112's hum.
   - Found on the way:
     - the exporter drew courses 2-8 with course 1's BG palettes;
     - the engine's boost rolling handlers were wrong (now traced: web_boost, web_boost_side);
     - a poke of `$6A5A` alone leaves `$6A5C` at 0.
   - Left: objects 116-118's cycles (with the `$58-$5D` tiles), the scenery's own cycles, the ability species' pose and pulse as two cycles.
2. **An active-player handle**, replacing `queryFirst(BallWork)`, even before 2P. It is cheap at about 10 sites, and expensive once the abilities add more.
   - **Done 2026-11-15** (docs/engine.md "Traits"). `core/traits/player.ts` defines the tags `IsPlayer` and `IsActivePlayer` (`$1803`) and the lookups `activePlayer` (throws) and `findActivePlayer`. It replaces the helpers `ball()`, `ballEntity()` and `counters.ts`'s `player()`, and every bare `queryFirst(BallWork)` in core, the game layer and the tests (about 60 sites). `spawnBall` is now `spawnPlayer`.
   - `test/no-phaser-in-core.test.ts` fails on any `queryFirst` on a player trait, so new sites can't bypass the handle. `hole-entities.test.ts` pins the one player's life from `startCourse` through CONTINUE.
   - No behaviour changed: all 466 tests pass with every trace still frame-exact, and so do the e2e pages.
   - Left for step 9: `PlayerSlot` and `setActivePlayer`, pad 2, and the tomato queue's per-player entries.
3. **The snap gate `$82:A692` and its clamps.** One routine and a trace unblock 14 1P holes and 14 extra-game holes.
   - **Done 2026-11-15** ([notes/port-v2-phase3-snaps.md](../notes/port-v2-phase3-snaps.md); docs/tiles.md "Snap panels", docs/animation.md "Objects 61 and 62", docs/engine.md). The handlers `$82:A5B1`/`$82:A5E6`, the gate, and the push `$82:A5F7` are ported exactly. The push is ±`$300` a frame to ±`$2000`; on `$19` the game skips the store at the cap, a bug the engine keeps. The landing path rolls on the same frame.
   - Also ported: the star trail. Object 61 spawns bursts of four object 62s, whose motion lives in the draw routine (`$80:E97C`, the polar table `$80:EABA`). The 64 scripts are exported from the ROM (`snapStars`), and object 62's sheet is in the objects atlas (`SnapStarsView`).
   - Five poked scenarios on holes 54, 29 and 62 match frame for frame. They check the ball states and sounds (`trace-terrain`) and each star's states (`snap-stars`, with `trace_actors.py` now recording the slots' exits). 495 tests pass, and so do the e2e pages.
   - Found on the way:
     - the aim's guide leaves its own `$DA3A`/`$6A72` in the work copy (`$81:B24C`), which a landing on a panel rolls with; the engine now writes them back;
     - every shot's set-up resets the coefficients (`$80:C688`), not just the hole's start; now ported;
     - course 7 hole 7's reveal delays the HUD's tomato by 4 frames (lag).
   - After it: 1P 17 clean, 42 at course-1 level, 5 blocked (§1). The random holes' solve rates are unchanged (29, 28, 20 of 30).
4. **The water `$60-$6F`.** 17 1P holes, and it fixes course 1's own holes 7 and 8.
   - **Done 2026-11-15** ([notes/port-v2-phase4-water.md](../notes/port-v2-phase4-water.md); docs/tiles.md "Water", docs/animation.md "The water's objects", docs/physics.md "In the water", docs/engine.md). Both handlers (`$82:80F6`, `$82:8000`) are ported exactly: the region, the level, the entry (÷ 2 or ÷ 8, one frozen frame), the drag, the way out, skims, skips and the modifier's bounce. So is the guide's own water model. The ability modes' branches are ported as read and untraced.
   - Also ported:
     - the splash objects 53-58 and the bubble emitter 67, with the game's random numbers (`$80:87DD`, `sim/rng.ts`);
     - Kirby's wet palette (OBJ palette 0 colours 2-6, a second Kirby frame set);
     - the guide's pictures from the water;
     - the sounds `$47`, `$48`, `$49` and `$4C`.
   - Eight poked scenarios and one played shot on course 1 hole 7 match frame for frame: the ball states, the sounds, `$D872`, the palette, and every splash's and bubble's states, with the random state seeded at the set-up. The guide's ends over the water match too. 565 tests pass, and so do the e2e pages, with a new `water.mjs`.
   - Found on the way:
     - the engine's `overlayProbe` set `$D9EE`, where the ROM only clears it;
     - the modifier's bounce stores the wrong factors (vx and vz take `$8340`'s, vy keeps its own);
     - object 67's waits read past their table into code;
     - `$84:9A38` rewrites Kirby's outline colour every frame, so only colours 2-6 change in the water;
     - a splash in Kirby's OAM queue covers him, one queue back is behind him (which may also hold for the snap stars, unconfirmed).
   - After it: 1P 20 clean, 39 at course-1 level, 5 blocked (§1). Course 1 hole 7 is clean; hole 8 keeps its `$5C`.
   - Left: the ability's drop on entering water (`$D9C6`, step 5), `$69CA`'s toggles (step 6), player 2's palette (step 9), and water in the random holes.
5. ~~**The copy abilities**, recorded from demos 10-19.~~ **Done** (notes/port-v2-phase5-abilities.md):
   - All ten abilities, the trigger and the transformation, the per-mode handlers and their tile branches, the hit codes in the mode, the stock's life in 1P.
   - The presentation: Kirby's ability poses by their switches, his colours (the flash, the outline's green flash, Fireball's set and fade, Spark, Freeze, the UFO's colours and warning), the HUD's icon and the UFO's countdown, the drawn objects (21, 27, 28, 31, 32, 33, 35, 37, 39, 65, 66), the objects' and the scripts' sounds.
   - Demos 10-19 play from the ROM's streams in the harness (`test/demo-harness.ts`, `core/demo.ts`) and match end to end; twelve stepper scenarios (`test/ability-scenarios.ts`), web_ab_c1 frame-exact. 654 tests pass, and the e2e pages with a new `ability.mjs`.
   - Found on the way: the rough `$04`'s table offset and sound, the kickers' land and hit, the crest's cross-cell branches `$81:9831`, the rolling step hit's launch, the take's halves, `$80:F445`'s `$D76C`, the outline phase's 41-tick wrap.
   - After it: 1P 57 clean, 2 at course-1 level (the `$5C`/`$5D` holes 7 and 23), 5 blocked (§1).
   - Left: the 2P parts (step 9), the overlays and the frame index, the objects never seen.
6. ~~**The toggles and `$58-$5D`**, for the last 5 blocked 1P holes, and `$5C`/`$5D` on 2 more.~~ **Done 2026-11-15** ([notes/port-v2-phase6-switches.md](../notes/port-v2-phase6-switches.md); docs/tiles.md "Swirls", "The toggles' switch", "The water switch"; docs/courses.md "The switches' objects"; docs/engine.md):
   - The swirls `$70-$7B` (a push round the cell's centre in a disc), the toggles' switch `$5A`/`$5B` (`$6A2A`) and the water switch `$5C`/`$5D` (`$69CA`, a 64-frame block while the water's tiles dissolve) are ported exactly. Their presentation is ported too: the switch's tiles, objects 117 and 118's colours, object 127's frames (which turn the whole floor on those holes), and the dissolve pixel by pixel. `$69CA` moved from the course into the work copy.
   - Eight poked scenarios on holes 10, 25, 26, 7 and 23 match frame for frame: the ball states and the sounds; on the iteration clock, the switches' globals, the colours, object 127's frames, Kirby's squash and the block. `tools/check_switch_gfx.py` finds the VRAM model exact. 673 tests pass, and so do the e2e pages, with a new `switch.mjs`.
   - Found on the way:
     - the swirls turn the ball round the centre, not along a direction;
     - the rolling side's magnitude is the disc's bitmap byte, because `$B6` is overwritten (`$80:DDED`/`$DDF1` are dead);
     - the water switch's two tile records are the same bytes;
     - a hard landing on the water switch squashes Kirby with no return;
     - `toggleImpulseBig`/`Small` were misnamed.
   - After it: 1P 64 clean, the extra game 64 (§1). The random holes' solve rates are unchanged by it (29, 30 and 24 of 30, as at the phase's start).
   - Left: `$58`/`$59` and the 2P branches (step 9), the objects' phases at the load.
7. **The shell:** the per-hole card, pause and the overview, the course map, title → map → course, the medals and SRAM.
   - **In progress, 2026-11-16** ([notes/port-v2-phase7-shell.md](../notes/port-v2-phase7-shell.md); docs/flow.md, docs/save.md, docs/engine.md). Five pieces, in order (the user's choice); NAME ENTRY is skipped and the save is the engine's own JSON.
   - **Piece 1 done:** the aim's other inputs in the game's order: the pause menu (CONTINUE / COURSE SELECT SCREEN / QUIT), the spin preset (B), the look (Y, with its arrows), L/R's octant snaps, B's cancel in the spin stage (with its 20-iteration lockout), and the score panel's real rule (`$EA7C` at its 1P sites; `$691A` gating the tomato queue). Seven new scripts, every watched word ±2 frames.
   - **Piece 2 done:** the per-hole RESULT card (`$83:D3ED`: its timeline frame-exact on web_card, the course's window, the number objects at the ROM's slots), SELECT's mid-course card (BEST and YOUR SCORE), and every hole's night computed from the ROM's alternate tables. Not drawn: the card's flying star, the numbers' pop-in.
   - **Piece 3 done:** the save ([save.md](../docs/save.md)): the members, the rounds, the medals, the cleared count, the ranking with its built-in records; five autoplay saves replayed through the rules equal the game's. The host keeps it in localStorage.
   - Found on the way: the plan's "overview (B)" is the spin preset; SELECT is the mid-course card; `$3798` is a ROM checksum (the GAME OVER's SRAM wipe never runs); the cup reveal's lag comes after the HUD thread took a waiting tomato; the card waits on the *held* pad.
   - **Left: pieces 4 and 5** (the course loop's screens and the front). The course's end is animation-heavy (`$83:C787`'s dance, `$83:C9FF`'s tally with sfx `$44` per hole, scene 8's objects in bank `$85`, songs 19, 1 and 15), so each screen needs either its objects ported or a recorded replay like the hole's cutscenes.
8. **The extra game and King Dedede.** The extra game is nearly free after steps 1-6; Dedede needs his own RE.
9. **Two players:** the turn loop, the HUD, the steal, ball-to-ball hits, the handicap and dice.

## Appendix: the per-hole tally

How each hole is classified:
- **Input:** `build/courses/NNN_MAPxx/` (`python3 tools/courses.py`): the grid size from `map.json`, layer 2 from `t02_*.bin`.
- **The tile groups:** each non-zero layer-2 byte is grouped by its landing handler, through `landDispatch` and `dispatchHandlers` in `build/engine/rules/tables.json`.
- **Abilities:** an enemy's ability comes from `enemyAbility` (`$82:B6EB`).
- **Stubs:** a layer 2 shorter than w×h is a stub.

```python
import glob, json, os
R = 'build/engine/rules/tables.json'; t = json.load(open(R))
name = {d['id']: d['name'] for d in t['dispatchHandlers']}
land, abil = t['landDispatch']['values'], t['enemyAbility']['values']
BLOCK, PARITY = {'switch58', 'roulette'}, set()  # 'snap' left BLOCK at step 3, 'overlay' PARITY at step 4, 'ability' at step 5, the swirls and switches at step 6
for d in sorted(glob.glob('build/courses/[0-9][0-9][0-9]_MAP*')):
    m = json.load(open(f'{d}/map.json')); n = m['grid_width'] * m['grid_height']
    l2 = open(glob.glob(f'{d}/t02_*.bin')[0], 'rb').read()
    if len(l2) < n: print(m['index'], 'stub'); continue
    g = set()
    for v in l2[:n]:
        if not v: continue
        h = name[land[v]]; g.add('toggle' if h.startswith('toggle') else h)
        if 0x40 <= v <= 0x57:
            a = abil[v - 0x40]; g |= {'roulette'} if a == 11 else {'ability'} if 1 <= a <= 10 else set()
    print(m['index'], 'blocked' if g & BLOCK else 'parity' if g & PARITY else 'clean', sorted(g & (BLOCK | PARITY)))
```

Run it from the repo root. The counts in §1 are this output, grouped by index range.
