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
| 0-63 | 1P courses 1-8 | 15 | 30 | 19 |
| 64-127 | extra game: the same terrain, a different layer 2 | 5 | 40 | 19 |
| 128-159 | 2P. Only Whispy Woods (128-135) has been run ([physics.md](../docs/physics.md) "The extra game and two players") | 3 | 6 | 23 |
| 160-179 | **unconfirmed**: the 20 DEMOPLAY holes. Each of MAPC0-MAPD1 holds exactly one ability species, and together they cover all ten abilities | 8 | 11 | 1 |
| 192-223 | a second layer 2 for MAP80-MAPB7; what selects it is unknown | 2 | 3 | 27 |
| 224-243 | stub layer 2: a lone `$0C` and no enemies, so no cup is possible | — | — | 20 |
| 184 | **unconfirmed**: Dedede's arena. physics.md puts the extra game's Dedede at 184. The slot holds the "shared filler" entry, whose header `$9F:EB41` is a real 16×16 hole named `MAPF0`. Not exported | | | |

The columns:
- **Clean:** every layer-2 tile goes through a ported handler.
- **Course-1 level:** the hole also uses what course 1 ships with today:
  - the water `$60-$6F`, treated as plain ground;
  - ability enemies, whose take is ported but which grant nothing;
  - the `unk5c` handler (`$5C`/`$5D`: course 1 hole 8 has a `$5C`).
- **Blocked:** the hole has the snap tiles, the toggles, `$58-$5B`, or the roulette `$57`.

Two things do not affect any hole:
- the warps' random pick: no ROM hole has a warp list other than 0 or 2 panels;
- an unported hazard actor: every actor `$82:BDBC` spawns is type 72, 73, 76, 77 or 81-83, and the engine ports all of them.

Not counted, because they touch every hole: the crest's cross-cell branches (`engine/src/core/sim/roll.ts:30-50`) and the game's lag frames.

### What blocks the 1P holes

| feature | 1P holes | engine | RE state |
|---|---|---|---|
| snap tiles `$18-$1B`: the gate `$82:A692` and the exact clamps | 14, all with no other blocker: 29, 32, 37, 39, 41, 45, 49, 50, 52, 54, 55, 57, 62, 63 | `sim/dispatch.ts:458`: the gate always passes, and the impulses are placeholders until a trace | one routine to read, then a stepper trace |
| toggles `$70-$7B`, always with `$5A`/`$5B` | 5: 10, 19, 25, 26, 43 | stub: plain ground (`dispatch.ts:166-184`) | the direction map `$88:9190`, `$82:A086`/`$A0D9`/`$A0F9` (unread). **Unconfirmed:** `$5B` is the toggle's switch. It occurs in 30 holes, and all 30 have toggles (35 holes have toggles) |
| `$58-$5D` | `$5A`/`$5B` in the 5 above; `$5C`/`$5D` in 2 (hole 7, which is course 1 hole 8, and 23) | stub | handlers located, not read ([tiles.md](../docs/tiles.md) "Not established") |
| **water** `$60-$6F` | 17: 6, 7, 12, 20, 22, 23, 27, 31, 32, 33, 35, 50, 52, 55, 57, 62, 63 | stub: plain ground, **course 1's holes 7 and 8 included**. The `$D9EE` flag is ported | `$82:80F6`, `$69CA`/`$69D2-$69DA`, Kirby's state 19 (the sink). What the water does to a ball is unknown |
| **ability enemies** | 38 of 64. Per course: 3, 3, 3, 5, 6, 5, 7, 6. Course 1 has `$42` Parasol and `$48` Hi-Jump | the take is ported and the ability stored, but nothing uses it | §3 |

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

## 3. Copy abilities: mostly RE

Known:
- **The ids** in `$7E:D85A`: 1 Stone, 2 Parasol, 3 Fireball, 4 Needle, 5 Tornado, 6 Wheel, 7 Spark, 8 Hi-Jump, 9 Freeze, 10 UFO. They are set through the jump table `$82:C90A`, in the order of demos 10-19 ([animation.md](../docs/animation.md)).
- **Which enemy gives which**, `$82:B6EB` by species (tile − `$40`), already in `tables.json` as `enemyAbility`:
  - `$41`-`$49` give 1-9;
  - `$4F` and `$52` give 10;
  - `$57` is the roulette (11);
  - the other species give nothing.
- **The friction and gravity rows** for 22 modes, `$80:DC49` and `$80:DB6D` (physics.md "Rolling friction").
- **Hi-Jump's relaunch** at 65° (`$82:CC4F`).
- **Kirby's pose setter for each ability**, from `$82:C95B` on; Spark has none (animation.md).
- **The swallow** `$82:D9E9`/`$82:DA4D`, and the ability's drop at a shot's end, `$80:C756` unless `$80:DEFD` keeps it.

Unknown:
- how the player triggers an ability;
- what each ability does to the ball, beyond the table rows and Hi-Jump;
- the pairing of modes and abilities, which is certain only for Stone (1) and UFO (`$0A`);
- the meaning of modes 11-21.

The engine:
- `BallMode` is always 0 (`core/traits/ball.ts:25-26`), but about 33 per-mode branches already exist in the kernels.
- Missing branches:
  - mode 5's rescale (`sim/wall-step.ts:80`);
  - the mode-7 destroy of pillars and hazards (`sim/dispatch.ts:530`);
  - the Dedede flag in `sim/still.ts`, never passed by `ball-step.ts:358`.

**Lead:** demos 10-19 each show one ability (DEMOPLAY, scene 13). The stepper can record a reference trace for every ability without hand-made input scripts.

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
| the per-hole RESULT card | scene 3, `$81:F92B`/`$F98C` | nothing blocks it; the engine just goes to the next hole (`game/scenes/hole-scene.ts:246-248`) |
| pause; the overview (B); the look-around (Y); the aim's L/R snap and B cancel | `$83:AFA7`, `$83:B214`, `$81:B9A2`; `sim/aim.ts:35-53`, `systems/panel.ts:75` | unread ([flow.md](../docs/flow.md)) |
| the course map, the course intro | scene 5 `$83:9690`, scene 11 `$86:FD0B`; the cleared courses `$7E:D7BE` from SRAM (`$81:FB9C`) | the cursor, the advance animation |
| the course result, the ranking, the medals | scenes 8, 4 and 15 (`sub_medal_award $83:F985`); the medals at `$70:021A` | the score formula, the medal thresholds |
| SRAM | 8 KB, 64-byte slots, partly mapped | the drawings, the best scores, the checksum |
| the logo, the title, the attract demo | scenes 16 and 1; the title map `$92:8550` | which hole the attract plays, its input source |
| the title menu, the hidden items | gates `$7E:EAA9`-`$EAB3` (`$81:C7AF`); MAP SELECT, SOUND ROOM, DANCE SELECT | the menu logic |
| the name entry (a drawing pad) | scene 2, `$81:DFD9`, the zones `$81:E0C7` | how a drawing is stored |
| DEMOPLAY | scene 13, 20 demos | the input source; which holes (160-179, unconfirmed) |
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
4. **The water `$60-$6F`.** 17 1P holes, and it fixes course 1's own holes 7 and 8.
5. **The copy abilities**, recorded from demos 10-19. They gate exact play on 38 of the 64 1P holes, course 1 included.
6. **The toggles and `$58-$5D`**, for the last 5 blocked 1P holes, and `$5C`/`$5D` on 2 more.
7. **The shell:** the per-hole card, pause and the overview, the course map, title → map → course, the medals and SRAM.
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
BLOCK, PARITY = {'toggle', 'unk58', 'unk5a', 'snap', 'roulette'}, {'overlay', 'ability', 'unk5c'}
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
