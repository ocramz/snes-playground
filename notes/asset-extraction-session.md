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
- **Enemy identity.** Layer-2 values `$40-$52` and `$57` map to actor ids
  `$0048-$0053` via `$82:BDBC`, but what `$82:B3AF` builds from those ids,
  and therefore which enemy is which, is unknown.
- **Five loader entries** pick their VRAM record block from a table at run
  time: `$80:CF06`, `$80:CFF8`, `$80:D030`, `$80:D10C`, `$80:D252`.
- **Three scenes** (7, 10, 14) have no call site with an immediate scene
  number, so nothing selects them the obvious way.
- **Scene identities.** Only the course scene is named from its entry
  routine. The others are listed by entry site in `build/scenes/callers.tsv`.
- **The title tilemap.** The three title streams are all 4bpp tile data; the
  map comes from somewhere else, probably the resumable decompressor queue
  at `$80:A032`.
- **No string pointer table** has been found, so a string cannot be tied to
  the screen that shows it.
- **1,304 streams** in `build/manifest.tsv` are still `lead`: found by the
  compression scan, referenced by nothing. Some are real assets, some are
  alignment accidents.

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
