# Course data

Course (hole) data lives in eleven parallel pointer tables in bank `$88`,
starting at `$88:A770 (0x042770)`, each 0x300 bytes apart, each holding 256
three-byte long pointers.

Verified by disassembling the two loaders at `$82:B14B (0x01314B)` and
`$82:B20C (0x01320C)`, which index every table with the same value.

## Indexing

The hole index times three sits at `$7E:ABB6`. Both loaders do:

```
LDX $ABB6
LDA $88:<table>,X      ; low 16 bits of the long pointer
TAY
LDA $88:<table>+2,X    ; high byte (bank), in the low byte of A
TYX
LDY #<destination>
JSL $80:9F18           ; sub_hal_decompress
```

Table 0 is the exception: it is **not compressed**, and is copied 32 bytes
at a time by `$82:B1DC`.

232 slots in 0-243 are populated; the rest all point at one shared filler
entry per table. The hole index is computed as `course * 8 + hole` by
`$82:B0A4`, from the course number at `$7E:6A5A` and the hole at `$7E:6A5E`.

Each course appears **twice**, at `i` and `i+64`, under the same name —
indices 0-63 and 64-127 are both `MAP00`-`MAP77`, and 128-179 and 192-243 are
both `MAP80`-`MAPE3`. Between a pair, **layers 1, 3 and 4 are byte-identical
and only layer 2 differs**: the same terrain with a different set of hazards
and enemies. So there are 116 distinct *geometries* but 232 distinct *holes*,
and which count applies depends on the layer you are measuring.

## The tables

| # | address | dest | size | contents |
|---|---|---|---|---|
| 0 | `$88:A770` | `$7E:8B90` | 28 raw | header: 8 words then a 12-byte name |
| 1 | `$88:AA70` | `$7E:6B90` | w*h | grid layer: terrain shape |
| 2 | `$88:AD70` | `$7E:8390` | w*h | grid layer: object ids |
| 3 | `$88:B070` | `$7E:7390` | w*h | grid layer: elevation |
| 4 | `$88:B370` | `$7E:7B90` | w*h | grid layer: edge wall flags |
| 5 | `$88:B670` | `$7E:93B0` | ~114 | 16-bit table, `$FF`-padded |
| 6 | `$88:B970` | `$7E:9BB0` | ~114 | 16-bit table, `$FF`-padded |
| 7 | `$88:BC70` | `$7E:8BB0` | ~114 | 16-bit table |
| 8 | `$88:BF70` | `$7F:3000` | 704-16,880 | SNES tilemap |
| 9 | `$88:C270` | `$7F:9800` | 704-16,880 | SNES tilemap |
| 10 | `$88:C570` | `$7E:A3B2` | ~150 | 16-bit table |

Tables 1-4 are four parallel grid layers, one byte per cell. **Courses are
not all 12x12**: header words 1 and 2 give the dimensions, and word 0 is
their product. Checked against all 232 holes, table 1's decompressed size
equals header word 0 exactly, every time. Sizes run from 12x12 (44 holes)
through 12x28, 16x16 and 28x28.

### What each layer is

Layers 1 and 3 are the playfield geometry: **layer 1 is a terrain shape id
and layer 3 is elevation**. Both are read by `sub_terrain_probe` at
`$81:9479 (0x009479)`, so this is disassembly, not inference — see
[the terrain model](terrain.md) for the full write-up, the shape table and
the surface equation.

In brief:

- **Layer 1** is an enum `$00-$1B`: 28 shapes, of which `$03` is unused by
  any course. `$00` means **no cell here** — a gap; `$01` is flat; `$02` is
  a mound. The remaining 24 are sloped, in six families of four 90°
  rotations, so `shape = (family << 2) | rotation`.
- **Layer 3** is elevation in whole cells, `$00-$0F`. One step is `$5A82` in
  the engine's 16.16 world Z. A flat cell of height `h` has its walkable top
  at `(h+1)` steps.
- **Layer 4**'s low nibble is four per-edge wall flags, read at
  `$81:92B0` and masked with `$80:8815` (`01 02 04 08 ...`) for direction
  0-3 = N/E/S/W. The high nibble is never read in banks `$80-$87`; meaning
  unknown.
- **Layer 2 is the special-tile layer** — hazards, friction changes, boost
  panels, enemies — and is **never** non-zero where layer 1 is `$00`. The
  byte is a jump-table index: `$81:811B` dispatches it through 256 long
  pointers at `$81:8136`. See [special tiles](tiles.md).

Note when counting: because layers 1, 3 and 4 are duplicated between `i` and
`i+64` but layer 2 is not, **terrain statistics should be taken over the 116
geometries** (29,949 cells) and **tile statistics over the 232 holes** — 212
of which have a full-size layer 2, for 7,947 non-zero cells. Every histogram
bucket for layers 1, 3 and 4 being an even number is that duplication, not a
coincidence.

Reproduce all of the above with:

```bash
python3 tools/terrain.py --tables            # the engine's shape tables
python3 tools/terrain.py --stats             # cross-check tables vs data
python3 tools/terrain.py --index 0 --legend  # one hole, decoded
python3 tools/courses.py                     # extract, then
python3 tools/course_stats.py                # the older per-layer statistics
```

### The 20 short-layer-2 holes

Exactly 20 holes — `MAPC0`-`MAPC7`, `MAPD0`-`MAPD7`, `MAPE0`-`MAPE3` — have
a **16-byte** table 2 instead of one byte per cell, while their other three
layers are full size. The contiguous naming says this is a deliberate
course category rather than corruption, but what the 16 bytes mean is
unknown. `tools/course_stats.py` skips these 20, so its statistics cover 212
holes and 55,664 cells.

Tables 8 and 9 are confirmed tilemap **data**: their high 6 bits (palette,
priority, flip) take only 8 distinct values across 1,656 entries, while tile
indices span 1-655. They are the two background layers of the isometric
course view, and they render as recognisable isometric terrain against the
tile set at `$8B:DAB1`.

**But they are not a plain screen-sized tilemap, and the correct width is
still unknown.** Tables 8/9 hold 8 to 25 times more entries than the
projected bounding box from header words 4 and 5 would need, with no
consistent ratio per hole. Against the count of *solid* cells (layer 1
non-zero) the ratio is much tighter, roughly 18-33 entries per solid cell
and typically around 24. That is consistent with a library of per-cell tile
groups assembled at draw time rather than a flat background image, but the
assembly code has not been traced, so this is a lead and not a conclusion.

Rendering one with `tools/tilemap.py --width N` therefore produces correct
tiles in the wrong arrangement. Finding the real layout means disassembling
whatever consumes `$7F:3000` and `$7F:9800`.

## Header format

28 bytes: eight little-endian words, then a 12-byte space-padded ASCII name.

Hole 0, at `0x0FF829`:

```
0090 000C 000C 1560 0060 0039 0000 00E8  "MAP00       "
```

| word | hole 0 | meaning | confidence |
|---|---|---|---|
| 0 | `$0090` = 144 | cell count, `= word1 * word2` | **exact, 232/232 holes**, and equals the size of grid layers 1-4 |
| 1 | `$000C` = 12 | grid width | exact |
| 2 | `$000C` = 12 | grid height | exact |
| 3 | `$1560` = 5472 | bounding box area, `= word4 * word5` | **exact, 232/232** |
| 4 | `$0060` = 96 | projected pixel width, `= 4 * (width + height)` | **exact, 232/232** |
| 5 | `$0039` = 57 | projected pixel height | see below |
| 6 | `$0000` | always zero in every hole | |
| 7 | `$00E8` = 232 | unknown; takes few distinct values | |

Word 4 being exactly `4 * (width + height)` is the signature of an
**isometric projection**: a diamond laid out from a `w x h` grid is
`(w + h)` half-tiles wide. So the courses are drawn isometrically and word 3
is the pixel area of the bounding box.

Word 5 is the matching projected height. It is always `2 * (width + height)`
plus an odd number from 9 upward that grows with terrain elevation
(verified: `word5 - 2*(w+h)` is positive and within `4*maxheight + 16` for
all 232 holes). A closed form eluded me — `2*(w+h) + 2*maxheight + 9` fits
only 50 of 232 — because the projected top depends on *where* the tall
cells are, not just how tall the tallest is.

Names run `MAP00`, `MAP01`, ... and also `MAPE2`, `MAPF0`, `MAP46`, so the
naming is not a dense sequence — the table is ordered by index, not by name.

## Extracting

```bash
python3 tools/courses.py                    # all 232 holes -> build/courses/
python3 tools/courses.py --index 0 --dump   # one hole, to stdout
```

Each hole gets a directory `NNN_NAME/` with one file per table. To view a
course background you need its tile source, which is loaded separately by
the screen setup code and is not in these tables:

```bash
python3 tools/tilemap.py build/courses/000_MAP00/t08_9C85D0.bin --guess
python3 tools/tilemap.py build/courses/000_MAP00/t08_9C85D0.bin TILES.bin \
    --width 46 -o build/courses/000_MAP00/bg.png
```
