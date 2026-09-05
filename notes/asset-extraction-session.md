# Asset extraction — session notes (2026-09-04)

What was established, what is still guesswork, and what to try next.

## Confirmed (from disassembly, not pattern matching)

- **HAL LZ format** at `$80:9F18`. Full command set including the
  bit-reversed and backward copies, and the big-endian copy offsets.
  All 28 call sites and all 1,298 course pointers decompress cleanly.
- **APU upload path**, all three routines, and the block-chain format.
  33 songs, 25 distinct BRR samples, 78 instruments.
- **Course tables**: eleven parallel tables in bank `$88`, indexed by
  `$7E:ABB6`, with every destination address read off the two loaders.
- **Metasprite records**: 5 bytes, field mapping taken from the OAM store
  sequence at `$80:8DE4`.
- **Text encoding**: glyph indices, `A-Z` at `$21-$3A`, `a-z` at `$51-$6A`.
  Verified against "CONTINUE", "COURSE SELECT SCREEN", "Congratulations".

## Resolved since the first pass

- **Course dimensions are not fixed.** Header word 0 is the cell count and
  equals width x height (words 1, 2) in all 232 holes, and equals the size
  of grid layers 1-4 every time. Sizes run 12x12 through 28x28. The earlier
  "144-byte 12x12 grid" claim was an artifact of only looking at hole 0.
- **Courses are drawn isometrically.** Header word 4 is exactly
  `4 * (width + height)` in all 232 holes — the projected pixel width of a
  diamond — and word 3 is `word4 * word5`, the bounding box area.
- **Layer meanings.** First read off statistically, now confirmed by
  disassembling `sub_terrain_probe` at `$81:9479` — see
  [docs/terrain.md](../docs/terrain.md). Layer 1 is a terrain *shape* enum
  `$00-$1B` (`$00` = gap, `$01` = flat, six families of four rotations),
  layer 3 is elevation `$00-$0F` at `$5A82` per step in world Z, layer 4's
  low nibble is four per-edge wall flags, and layer 2 is the object layer
  (swept at load by `$82:B320`, values looked up in `$82:BDBC`).
- **Each course appears twice**, at `i` and `i+64` under the same name, but
  only the *geometry* is duplicated: layers 1, 3 and 4 are byte-identical
  between the pair and **layer 2 differs**, giving the same terrain two
  different hazard/enemy layouts. So 116 geometries but 232 holes — count
  terrain over 116, tiles over 232. The hole index is `course * 8 + hole`
  (`$82:B0A4`). An earlier revision of this note said the whole hole was
  duplicated; that was wrong.
- **The course tile sets.** `sub_course_enter` at `$80:C307` loads them via
  jump tables before the tilemaps: `$8B:DAB1` (18,944 bytes) is the
  isometric terrain, `$8D:CA0A` the font/HUD to VRAM `$6000`, `$90:9E9E` to
  VRAM `$0000`. Terrain renders as recognisable isometric geometry.

## Unconfirmed — do not repeat these as fact

- **The layout of course tables 8 and 9.** They are genuine tilemap words
  and the tiles are right, but they hold 8-25x more entries than the
  projected bounding box needs. Per *solid* cell the ratio is much tighter
  (18-33, usually ~24), suggesting per-cell tile groups assembled at draw
  time rather than a flat background. Not traced. Any `--width` render is
  therefore right tiles, wrong arrangement.
- **Course header words 5, 7.** Word 5 is the projected height: always
  `2*(w+h)` plus an odd number from 9 up that grows with elevation, but no
  closed form fits (`2*(w+h)+2*maxheight+9` matches only 50 of 232) because
  the projected top depends on where the tall cells are. Word 6 is always
  zero. Word 7 takes few distinct values, meaning unknown.
- The **high nibble of layer 4** (`$80` is its commonest value and nothing in
  banks `$80-$87` reads it). Layer 2 is now grouped and half-decoded; see
  [docs/tiles.md](../docs/tiles.md) for which groups are still open.
- **The 20 `MAPC0`-`MAPE3` second copies** (indices 224-243) have a 16-byte
  stub layer 2 holding a single `$0C` rather than one byte per cell — so that
  variant of those courses has no hazards or enemies at all. Their first
  copies at 160-179 are normal. Whether the game ever selects them is not
  established.
- **Course tables 5, 6, 7, 10.** Small 16-bit tables. For hole 0, tables 5
  and 6 open with 13 words of `$FFFF` then step in regular increments
  (`$002E, $002C, ...` and `$0031, $0033, ...`), and table 10 steps by 6
  (`$0030, $0036, $003C, ...`). Table 7 is all zeroes. Regular strides
  after an `$FFFF` run smell like per-row offsets into the tilemap, but
  that is not established.
- **The `data` bucket in `build/gfx/index.tsv`** — 1,276 streams. Some are
  real assets in an unrecognised format, some are scan false positives.

## Dead ends worth not repeating

- Reading the striped-looking streams (`$99:B0AF` and friends) as Mode 7
  linear 8bpp tiles. They render as noise. They are tilemaps: the giveaway
  is that the high 6 bits of each word take only ~8 distinct values while
  the low 10 bits span hundreds. `tools/tiles.py --bpp 7` still exists for
  genuine Mode 7 data, but none was found.
- Pairing the three title-screen streams as tiles + tilemap. All three are
  4bpp tile data (`$8F:E6A4` included, despite its size looking map-like);
  the title tilemap comes from somewhere else.

## Next steps

1. Disassemble whatever reads `$7F:3000` / `$7F:9800` to learn how tables 8
   and 9 are laid out. That is the last thing standing between the extracted
   data and a correctly rendered hole.
2. Read the remaining layer-2 handlers (`$14-$17`, `$1C`, `$1D`, `$58-$5D`,
   `$B0-$B9`, and what the `$60-$6F` overlay actually is), and find who reads
   the high nibble of layer 4. Also decode `$81:9EB9`/`$81:9ED9`, the tables
   `$81:9444` uses to redirect velocity when a ball lands on a slope.
3. Walk the N-SPC sequence format in `build/spc/songs/*.bin` against the
   driver's parser at SPC `$0A22` to get note data rather than just
   playable SPC files.
4. Map the punctuation range of the text encoding.
