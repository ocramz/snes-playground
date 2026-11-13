# Asset extraction — session notes

Rewritten 2026-09-12. What is established, what is still open, and what to
try next. Anything here that graduated to a `docs/` page is summarised in one
line with a pointer rather than repeated.

## Settled, with a doc

- **HAL LZ** at `$80:9F18`, full command set — [compression](../docs/compression.md).
- **APU upload path**, 33 songs, 25 BRR samples, 78 instruments, the N-SPC
  sequence format and the sound effects — [audio](../docs/audio.md).
- **Course tables**, all eleven, including the **row directory** (tables 5,
  6, 7) that unpacks the two background tilemaps — [courses](../docs/courses.md).
- **Terrain**: shapes, elevation, the surface equation, gaps — [terrain](../docs/terrain.md).
- **Special tiles**: the dispatch tables and most groups — [tiles](../docs/tiles.md).
- **Screens**: the 20 setup blocks, the four loader jump tables, per-scene
  graphics and palette — [scenes](../docs/scenes.md).
- **Metasprites and animation scripts** — [graphics](../docs/graphics.md),
  [animation](../docs/animation.md).
- **Text**: the encoding read off the font sheet, control codes, strings —
  [text](../docs/text.md).

## Resolved this session (were "unconfirmed" before)

- **Tables 8 and 9 are row-packed, not a flat tilemap.** Tables 5/6/7 give
  each row's first column, last column and word offset. Asserted over
  232/232 holes by `coursemap.py --check`, and read off the column copier at
  `$80:BE17`. This was the last thing standing between the extracted data
  and a correctly rendered hole; every hole now renders.
- **Header words 3, 4, 5 are in 8-pixel tiles, not pixels.** Word 5 is
  exactly the length of tables 5/6/7 and word 3 is `word4 * word5`. No
  closed form for word 5 is needed — the directory gives every row's extent.
- **OBSEL is read, not inferred.** Screen block 0 at `$80:CB91` is
  `09 03 ...`: OBJ name base `$6000`, sprite sizes 8x8 and 16x16.
- **`$8D:CA0A` was mislabelled.** It is the course OBJ page, not the
  font/HUD. The course font is `$90:FBBC`, 2bpp on BG3.
- **Bank `$98` is the palette bank** — `sub_cgram_partial $80:90C8`
  hardwires its `MVN` source bank.
- **The per-course scenery** is BG3, selected by `course & 7` from
  `$80:D748` (tiles), `$80:D768` (tilemap) and `$80:D517` (a 40-colour
  palette). Without that palette the layer renders full of holes, because
  the course CGRAM image leaves BG3 sub-palettes 1-7 black.
- **Some graphics are not compressed at all.** Nine tileset loader entries
  DMA straight from ROM, so no compression scan will ever find them.
- **Three of the four unexplained decompression call sites** are the
  backdrop tilemap and two tileset loader entries. Only `$92:8FDE ->
  $7E:8BB0` is still unexplained, and that destination is where course
  table 7 lives, so something reuses the buffer.
- **Text digits and space.** The font sheet settles both: digits are
  `$10-$19` (previously "by analogy") and space is `$1F`, not `$00`.

## Still open

- **Course table 10.** ~150 bytes, read at `$82:F571`/`$82:F593` during ball
  physics. The first part looks like `w+h` words indexed by an isometric
  diagonal band, then per band a count byte and 5-byte records. Not traced.
- **Header word 7.** Always a multiple of 8. Equals `8*word5 - 224` for 86
  of 232 holes, so that is not it. No reader found.
- **Layer 4's high nibble.** `$80` is its commonest value and no read of it
  exists in banks `$80-$87`. Worth extending the search past `$87`.
- **Eight layer-2 handlers** are still `("?", "unknown")` in `terrain.py`:
  `$82:A980`, `$82:A6C7`, `$82:A70B`, `$82:A25D`, `$82:A1B1`, `$82:A3EB`,
  `$82:9342`, `$82:938E`. Also the `$60-$6F` overlay's identity and the
  `$70-$7B` family's purpose.
- ~~Enemy identity~~ -- settled: an actor id is a thread object type
  (`$82:B3AF` -> `JSL $80:E4B6`), confirmed by the 232-hole run. See
  docs/tiles.md "Actors".
- **Five loader entries** pick their VRAM record block from a table at run
  time: `$80:CF06`, `$80:CFF8`, `$80:D030`, `$80:D10C`, `$80:D252`.
  `tools/vram.py queue` now walks four of them to their end (3, 2, 8 and 2
  blocks); `$80:D030`'s first word is not a clean block, so that one is
  still open. Which entry runs is game state either way.
- **Three scenes** (7, 10, 14) have no call site with an immediate scene
  number, so nothing selects them the obvious way.
- **Scene identities.** Nine of twenty are named now (emulated; see
  docs/scenes.md). Eleven are unreached: they need progress in SRAM or a
  finished hole/course, see docs/emulation.md "Screens reached".
- ~~The title tilemap~~ -- settled by emulation: `$92:8550`, with tiles
  `$8B:8000` and `$92:C1F2`. The three streams once called title tiles
  belong to `$87:EB44`, screen unidentified (docs/compression.md).
- **No string pointer table** has been found, so a string cannot be tied to
  the screen that shows it.
- **1,093 streams** in `build/manifest.tsv` are still `lead`: found by the
  compression scan, referenced by nothing. Some are real assets, some are
  alignment accidents. (Was 1,304 before the scan decoded referenced
  streams first; 110 of those were chance decodes swallowing real ones.)

## Sprite session, 2026-11-13

Settled, with the evidence in [docs/graphics.md](../docs/graphics.md) and
[docs/animation.md](../docs/animation.md):

- The part record's size bit is byte 4 **bit 0** (`$80:8E08`), not bit 6.
- The "second object system" is a coroutine system of 234 object types,
  `tbl_thread_types $80:ED3A`; `$5E1C` is a frame table, `$5D9C` the index.
- Twelve helpers run from WRAM `$1018`-`$120D` and take inline operands;
  `JSR $1030 / idx / frames` is the animation primitive.
- `sub_vram_queue` takes its block's bank from the caller, and record byte 0
  is a mode into `tbl_dma_modes $80:FF0A`.
- Bank `$89`'s frame region is 99.8% explained: 125 tables, 1,163 frames.

Still open for sprites:

- ~~Enemy tiles~~ -- answered by emulation: `build/sprites/emu/` draws
  every object seen in all 232 holes with its live tiles (docs/graphics.md
  "From live state"). The static path below is still unexplained, but no
  longer needed to get the pictures. Was: 37 object types draw over tiles
  the hole-start object loaded and 36 over filler or empty slots. The enemy graphics go through
  the WRAM staging buffer at `$7E:39DA` into per-hole slots; the code that
  picks the slot is not traced, so these sheets are **unconfirmed** even
  where they look right. Leads: `$81:D082` (table `$81:D123`, eight slot
  layouts reading `$7E:3DFA` upward), tileset loader entries 6, 11, 12, 14,
  16, 20 and 23, and the queued decompress at `$87:D8C8`.
- ~~Script-driven Kirby during play~~ -- captured live:
  `build/sprites/emu/script_89_9295.png`, including the copy abilities from
  the 20 demos. The code path pairing index and tiles is still unread.
  Was: table `$89:9295` is rendered from the
  demo object (type 197), which shows the same layouts with real uploads.
  How the in-game Kirby pairs index and tiles is in the `$08` hook code;
  `$87:9E7A` is one worked example of the parallel-table idiom.
- **127 object types show no frame.** They set their index from a computed
  value, or get their table from a spawner the trace cannot name. Their
  tables are still on the table sheets.
- **Palette per screen.** Everything is drawn with the course CGRAM image
  plus the object's own partial loads. `$80:90E7` is a second palette entry
  point that takes a list of loads in the caller's bank and is not handled.
- **Which screen an object belongs to** is not known for any of them.
- 145 of 890 `sub_vram_queue` sites are not reached from a thread object:
  scene code in bank `$83` (66), the script-driven objects in `$87` (19),
  engine code in `$80`-`$82` (51), a handful elsewhere.

## Dead ends worth not repeating

- Reading the striped-looking streams (`$99:B0AF` and friends) as Mode 7
  linear 8bpp tiles. They are tilemaps. `tools/tiles.py --bpp 7` still
  exists for genuine Mode 7 data, but none was found.
- Pairing the three title-screen streams as tiles + tilemap. All three are
  4bpp tile data.
- Guessing a course tilemap width with `tilemap.py --guess`. The maps are
  row-packed; use `coursemap.py`.
- Rendering BG3 against the course CGRAM image. Sub-palettes 1-7 are black
  there; the scenery has its own per-course palette.

## Next steps

1. Disassemble `$82:F571` to settle course table 10, and search banks `$88+`
   for a reader of layer 4's high nibble.
2. Read the eight unknown layer-2 handlers and `$82:B3AF`, which together
   would finish the hazard and enemy inventory.
3. Name the remaining scenes by reading their entry routines, which also
   resolves the five run-time loader tables.
4. Work the `lead` half of `build/manifest.tsv`: anything a scene loader or
   course pointer does not reach needs another explanation.

## Audio session, 2026-11-13

Every song and effect now renders to WAV (`tools/render_audio.py`, 33 + 125
files, 42.7 minutes). Method and validation are in
[docs/audio.md](../docs/audio.md), "Rendering". Still open:

- **Nothing was compared with hardware.** The renderer agrees with
  `tools/brr.py` sample for sample and with VLC's libgme to an envelope
  correlation of 0.999, but libgme's level is 1.30x ours and that
  difference is not explained.
- **Effect tempo in play.** Effects are rendered over song 0, as the SOUND
  ROOM plays them. During a course an effect is clocked by whatever song is
  running, and 12 of the 33 songs do not use song 0's tempo.
- **Dropped ticks.** The driver loses a sequencer tick whenever a main-loop
  pass takes 14 ms or more, so songs run later than the tempo formula says
  (song 31 by 28%). Whether a console drops exactly the same ticks is
  unconfirmed.
- **Twelve songs have no fixed caller** (3, 6-14, 18, 27); that they are
  started by a script opcode is an inference. Songs are still numbered, not
  named.

## Emulation session, 2026-11-13

`tools/snesstep` runs the game headless (docs/emulation.md). Settled with
it: the title tilemap (`$92:8550`), nine scene identities, actor id ==
thread object type, live sprite sheets for every hole and demo (83 types,
1,596 pictures), and 75.1% ROM coverage once executed code counts. Still open:

- **Eleven scenes not reached** (3, 4, 7, 8, 9, 10, 14, 15, 17, 18, 19).
  They need SRAM progress or a finished hole. Forcing the holed branch at
  `$80:F37A` deadlocks two frames into the HOLE IN ONE sequence; finishing a
  hole for real needs a shot that goes in, i.e. aiming. A save file with
  progress would also open RANKING and the extra courses.
- **`$87:EB44`'s graphics** (`$8E:EC7F`, `$8D:9400`, `$8F:E6A4`, palette
  set 27) belong to one of the unreached screens.
- **Per-line CGRAM** (HDMA palette gradients) is not in a snapshot, and
  `ppu_render.py` does not model mosaic or hi-res.

## Physics and course play, 2026-11-13

Settled (docs/physics.md): the ball's state and one physics frame, the
cup as run-time object type 74 spawned at the last enemy, the holing rule,
defeat as a frame-table change, the screen projection, lives and the
courses-cleared count, and the ending's entry (`$80:F20E` -> `$87:E767`).
tools/snesstep/autoplay.py plays course 1 to the end with real hole-outs
and reaches scenes 4 (ranking) and 8 (course result); a slow hole reaches
scene 9 (GAME OVER, CONTINUE).

Still open:

- **The driver stops at course 2 hole 6.** Every hole so far has needed a
  new rule (hovering enemies, one-cell paths, non-enemy actors, lodged
  balls). The next step is to find the game's own "enemies left" count,
  which the cup logic must use, instead of inferring defeat.
- **The ending (scenes 18, 19)** needs 8 courses cleared. A forged save
  reaches the DEDEDE map, which then ignores input.
- Physics not read: slope acceleration (`$81:9001`, `$81:9444`,
  `$81:9EB9`), the bounce (`$81:811B`), spin.
- Scenes 3, 7, 10, 14, 15 and 17 are still unreached; 2-player results
  are a likely source of some.

## Enemies left, the cup, and the unreached scenes, 2026-11-13

Settled (docs/physics.md, docs/scenes.md):

- **The game's enemy count.**
  - `ram_enemy_list $7E:69DE` lists the hole's enemies, and the owner field `$539C` of each enemy's slot is 2 until a ball takes it.
  - `sub_count_enemies_left $82:8ACE` counts the 2s.
  - When one is left, it *becomes* the cup (`$82:8AEE`, `$82:8B5C`): tile `$08` at its cell, object 74 over it.
  - The earlier "cup spawned where the last enemy is defeated" was a misreading.
- **The enemy hit rule** (`$82:8990`):
  - the ball must be in the middle half of the cell;
  - an airborne ball must be within -0.5/+1 step of the enemy's hover height `$5B1C`;
  - each pass counts once, through the latch `$6A68`.
- **Why the driver stalled**, cause by cause:
  - it guessed defeats from the outside;
  - it aimed at the cup through the projection, which gave the wrong cell;
  - it lifted a ball out of the cup while it sank;
  - it placed the ball inside the hit zone straight from another enemy's, so the latch never cleared;
  - it ignored hover heights (4 steps on course 5 hole 6);
  - it measured heights from the elevation instead of the ramp surface;
  - it re-placed the ball before a lagging frame had moved it (course 8 hole 8).
- **King Dedede**:
  - `$87:E767` runs the final stage;
  - he has 24 HP at `$ED2D`;
  - damage per hit grows with the ball's height above the ground, from the table at `$87:EF88`.
- **Scenes:**
  - 3 = a ranking entry's RESULT card;
  - 15 = the medal award;
  - 17 = MAP SELECT;
  - 8 also hosts DANCE SELECT's dance;
  - 7, 10 and 14 are never requested by any code.
- **Hidden title-menu items:** MAP SELECT, SOUND ROOM and DANCE SELECT, gated on the medal flags `$7E:EAA9`-`$EAB3`.

Reached by playing:
- **The whole game.** tools/snesstep/autoplay.py, from a new game:
  - gold on all eight courses;
  - the medal award (scene 15);
  - King Dedede (24 HP, `sub_dedede_hit_test $87:EEEE`);
  - the ending (scene 18) and the credits (scene 19).
- **Screens:** tools/snesstep/ending.py snapshots the end screens. The new `ranking` and `map_select` scripts give scenes 3 and 17, and `sound_room` / `dance` give the other hidden menus.
- **Every scene with a request site** has now been rendered.

Still open:
- **The extra game**, which is still unplayed. It is reached from 1PLAY GAME → PLAY EXTRA COURSE (needs `$EAAB`, now set by the real save). Its own medal flags gate SOUND ROOM and DANCE SELECT, and its award texts are the EXTRA variants.
- **2-player results.** Nothing yet plays a 2P game to the end.
- **`$87:8B9B`**, the final stage's other exit, which clears the lives.
- **Physics not read:**
  - slope acceleration (`$81:9001`, `$81:9444`, `$81:9EB9`);
  - the bounce (`$81:811B`);
  - spin.
