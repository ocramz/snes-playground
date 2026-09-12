# The terrain model

How a hole's floor is represented: elevation, sloped tiles, and the gaps
between islands.

Everything here comes from `sub_terrain_probe` at `$81:9479 (0x009479)` and
the tables it indexes, cross-checked against all 116 distinct courses.
Reproduce with `python3 tools/terrain.py --tables` and `--stats`.

## The short version

Two of the four grid layers carry the geometry, one byte per cell over the
`w x h` grid from header words 1 and 2:

| | layer | WRAM | encoding |
|---|---|---|---|
| shape | 1 | `$7E:6B90` | enum `$00-$1B`; `$00` = gap, `$01` = flat, `$02` mound, `$03` dimple, 24 sloped shapes |
| elevation | 3 | `$7E:7390` | whole cells, `$00-$0F` |

A **gap** is `layer1 == $00`. **Elevation** is the layer-3 byte. A **slope**
is one of the 24 sloped shape ids, which say how the surface tilts *within*
the cell; the cell's elevation is still a single integer. Of the 28 shapes,
`$00` is the gap, `$01` is flat, and `$02` and `$03` are a mound and a dimple
whose slope is interior rather than a fall line, leaving 24 in six families
of four rotations.

## Elevation

One height step is **`$5A82` = 23170** in the engine's 16.16 world Z. That is
`65536 / sqrt(2)`, the isometric factor — a height unit is half a cell
diagonal, which is what makes a 45° ramp draw as a 45° ramp.

The conversion is a table, not a multiply: `$88:8000 (0x040000)` holds the low
words and `$88:80C8 (0x0400C8)` the high words of `Z(h) = h * $5A82`, indexed
by `h*2`. Checked for `h = 0..99`.

**The layer-3 byte is the elevation of the cell's *base*.** A flat cell's
walkable top is one step above it, at `(h+1) * $5A82` — handler `$81:9534`
loads `#$5A82` before adding the base. `$82:F53D` confirms it from the other
direction: it does `INC A` on the height byte before indexing the same table
to get a column top.

Elevation never exceeds `$0F`, so a course spans at most 16 levels.

## Shapes

Layer 1 is an enum with exactly 28 values, and two parallel 28-entry ROM
tables define each one:

- **`$81:9310 (0x009310)`** — 4 bytes, the surface level at each edge
  midpoint in **half** height steps, in the order **N, E, S, W**.
- **`$81:9D81 (0x009D81)`** — 4 words, a shape code per quadrant.

```
   t   edges NESW   quadrants   falls   family
  $00   0 0 0 0      0 0 0 0     -       gap
  $01   2 2 2 2      0 0 0 0     -       flat
  $02   0 0 0 0      1 2 3 4     -       mound
  $03   2 2 2 2      3 4 1 2     -       dimple      (unused by any course)
  $04   0 1 2 1      1 1 1 1     N       ramp
  $05   1 0 1 2      2 2 2 2     E       ramp
  $06   2 1 0 1      3 3 3 3     S       ramp
  $07   1 2 1 0      4 4 4 4     W       ramp
  $08   1 1 2 2      2 1 1 2     NE      faceted diagonal, upper half
  $09   2 1 1 2      3 3 2 2     SE          "
  $0A   2 2 1 1      3 4 4 3     SW          "
  $0B   1 2 2 1      4 4 1 1     NW          "
  $0C   0 0 1 1      1 2 2 1     NE      faceted diagonal, lower half
  $0D   1 0 0 1      2 2 3 3     SE          "
  $0E   1 1 0 0      4 3 3 4     SW          "
  $0F   0 1 1 0      1 1 4 4     NW          "
  $10   1 1 2 2      5 5 0 0     NE      diagonal, upper half
  $11   2 1 1 2      0 6 6 0     SE          "
  $12   2 2 1 1      0 0 7 7     SW          "
  $13   1 2 2 1      8 0 0 8     NW          "
  $14   0 0 1 1      0 0 5 5     NE      diagonal, lower half
  $15   1 0 0 1      6 0 0 6     SE          "
  $16   1 1 0 0      7 7 0 0     SW          "
  $17   0 1 1 0      0 8 8 0     NW          "
  $18   1 1 3 3      5 5 5 5     NE      diagonal ramp, full cell
  $19   3 1 1 3      6 6 6 6     SE          "
  $1A   3 3 1 1      7 7 7 7     SW          "
  $1B   1 3 3 1      8 8 8 8     NW          "
```

The structure is **`shape = (family << 2) | rotation`**, with `rotation`
(`value & 3`) selecting one of four 90° rotations in the same phase in every
family. That is visible in the table above — each block of four is one shape
turned four ways — and the course data agrees: the four rotations of a family
occur in near-equal numbers (`$04`-`$07`: 2510 / 2290 / 2230 / 2006 cells).

Directions are **grid** directions. Because courses are drawn isometrically
(header word 4 is exactly `4*(w+h)`), grid N/E/S/W are the four *screen
diagonals*, and the "diagonal" families `$18`-`$1B` are the ones that look
axis-aligned on screen. That, not a difference in geometry, is why both a
cardinal and a diagonal ramp family exist.

`$02` (mound) and `$03` (dimple) have level edges but sloped quadrants: a
mound peaks in the middle of the cell and a dimple sinks. No course uses
`$03`.

### The two diagonal families are not redundant

`$08`-`$0F` and `$10`-`$17` have **identical edge levels** (`t` and `t^$10`
match row for row) but different interiors. Bit 4 of the shape id is tested
at `$81:9516 (AND #$0010)` and routes to a different evaluator:

- `$08`-`$0F` build the surface out of **axis-aligned ramp triangles**
  (quadrant codes 1-4) — a faceted approximation of a diagonal.
- `$10`-`$17` use the **true diagonal** handlers (codes 5-8) on the sloped
  half and a flat quadrant on the other.

Since the edge levels match, the wall/step code at `$81:925E` can share one
table across both. Which family a course uses tracks its ramp system:
`$08`-`$0F` sit next to cardinal ramps, `$10`-`$17` next to diagonal ones.

## The surface equation

`sub_terrain_probe` at `$81:9479` takes a world position — cell column
`$7E:D9F2`, row `$7E:D9F6`, and 16-bit sub-cell fractions `$7E:D9F0` (x) and
`$7E:D9F4` (y) — and returns the ground height under it.

**1. Quadrant.** The cell is split by both diagonals into four triangles,
numbered in the same N, E, S, W order as the edge table:

```
x+y <  1 and x >= y  -> 0 (N)      x+y >= 1 and x >= y  -> 1 (E)
x+y >= 1 and x <  y  -> 2 (S)      x+y <  1 and x <  y  -> 3 (W)
```

**2. Cell index**, through the hardware multiplier, using header word 1 as
the width:

```
$949C  LDA $8B92 / XBA / ORA $D9F6 / STA $00:4202   ; WRMPYA=row, WRMPYB=width
$94A7  LDA $D9F2 / CLC / ADC $00:4216 / STA $D9FC   ; + col
```

**3. Bounds and fetch.** Column and row are each checked against 0 and the
header dimensions; out of range jumps to the same exit as an empty cell.

```
$94C7  LDA $7E:7390,X   ; elevation -> $DA00
$94D1  LDA $7E:6B90,X   ; shape     -> $D9FE, and BNE: zero means no cell
```

**4. Surface Z.** The quadrant's shape code selects a handler, all of which
add to the cell base `Z(h)`:

| code | surface |
|---|---|
| 0 | flat, top of cell (`+$5A82`) |
| 1 | ramp, rises with `+y` |
| 2 | ramp, rises with `-x` |
| 3 | ramp, rises with `-y` |
| 4 | ramp, rises with `+x` |
| 5 | diagonal ramp, rises with `(1-x)+y` |
| 6 | diagonal ramp, rises with `(1-x)+(1-y)` |
| 7 | diagonal ramp, rises with `x+(1-y)` |
| 8 | diagonal ramp, rises with `x+y` |

The rise itself comes from `$88:8190 (0x040190)`, a 1024-entry linear ramp
running `22 .. 46316`. Codes 1-4 index it with `frac >> 7` (0-511, so one
height step across a cell); codes 5-8 index the full 0-1023 (two steps across
the diagonal, hence one per axis). Codes 5-8 then subtract a per-shape bias
from `$81:9629 (0x011629)` — `$0000` for `$10`-`$13` and `$18`-`$1B`,
`$5A82` for `$14`-`$17`, which is what makes the "lower half" families sit a
step down.

`tools/terrain.py` implements this same function from the same tables:

```bash
$ python3 tools/terrain.py --probe 0 5 0
hole 0 'MAP00' cell (5, 0) index 5
  terrain $06 (ramp), elevation $01
  surface Z across the cell (fraction of a cell -> Z, in steps):
    y=0.0   1.999   1.999   1.999
    y=0.5   1.499   1.499   1.499
    y=1.0   1.001   1.001   1.001
```

A `$06` ramp at elevation 1 descends from 2.0 to 1.0 across the cell in `+y`,
which is exactly flush with the flat interior cell south of it (elevation 0,
top at 1.0).

## Gaps

A gap is not a special marker — it is the absence of a cell:

```
$94DA  STZ $D9FE / STZ $DA00 / STZ $DA0A / STZ $DA06 / STZ $DA08 / STZ $DA04
```

Shape `$00`, or a cell index outside the grid, makes the probe report
**ground Z = 0** and shape 0. Nothing ever stops a ball there; it keeps
falling. Once world Z drops below `-$0011_0000`, `$81:89AA` sets bit 0 of the
object's flag word `$7E:D9D2` and zeroes all three velocities:

```
$89AA  CMP #$FFEF / BCC $89B2
       JMP $899F              ; still falling, keep applying gravity
$89B2  LDA #$0001 / STA $D9D2 / STZ $D9D4 / STZ $D9D6 / STZ $D9D8
```

The per-frame driver at `$82:C085` picks that flag up and runs the
consequence via `$83:ABC5`.

**Islands** are just disconnected regions of non-`$00` cells. Of 116 distinct
courses, 106 are a single connected region, 7 have two and 3 have three
(4- and 8-connectivity agree, so the separations are real gaps rather than
diagonal pinches):

```
MAP45  65 + 30      MAP67  121 + 77     MAPC2  9 + 1
MAP56  69 + 4 + 1   MAP76  189 + 63     MAPD0  7 + 1 + 1
MAP60  65 + 35      MAPB5  45 + 25      MAPD4  4 + 3 + 1
                                        MAPE3  42 + 14
```

Interior holes in a course use the same `$00` encoding but do not show up as
separate components. Overall 59.4% of all cells are `$00`.

## Walls and steps between cells

The edge table is what lets the engine decide whether two neighbouring cells
join smoothly. `$81:925E (0x00925E)` computes the step across an edge:

```
surface level at side d of a cell = 2 * layer3[cell] + $81:9310[shape*4 + d]
```

in half height steps, and returns the difference between the two sides of the
shared edge. Zero means the surfaces meet flush — which is how a ramp joins
its neighbours. Positive is a step up (blocked); negative is a drop, and then
`$81:92AC` checks the layer-4 wall bit for that direction before allowing it.
Directions are the same 0-3 = N/E/S/W; the movement code's `EOR #$0002` for
"the opposite direction" confirms the ordering.

## Worked examples

**Hole 0 `MAP00`** — a sunken bowl. The rim is at elevation 1, the interior
at 0, and the transition is a ring of ramps facing inward, with the diagonal
family `$10`-`$17` at the corners:

```
 .  .  . 01 11 06 06 06 06 06 12 01        .  .  . 01 01 01 01 01 01 01 01 01
 .  .  . 11 15 01 01 01 01 01 16 12        .  .  . 01 01  .  .  .  .  . 01 01
 .  .  . 05 01 01 01 01 01 01 01 07        .  .  . 01  .  .  .  .  .  .  . 01
 .  .  . 05 01 01 01 01 01 01 01 07        .  .  . 01  .  .  .  .  .  .  . 01
 .  .  . 05 01 01 01 01 01 01 01 07        .  .  . 01  .  .  .  .  .  .  . 01
 .  .  . 05 01 01 01 01 01 01 01 07        .  .  . 01  .  .  .  .  .  .  . 01
 .  .  . 10 14 01 01 01 01 01 17 13        .  .  . 01 01  .  .  .  .  . 01 01
 .  .  . 01 10 14 01 01 01 17 13 01        .  .  . 01 01 01  .  .  . 01 01 01
 .  .  . 01 01 10 04 04 04 13 01 01        .  .  . 01 01 01 01 01 01 01 01 01
          layer 1: shape                            layer 3: elevation
```

(The grid is 12x12; the last three rows are empty and are omitted here.)

`$06` on the north edge falls S, `$05` on the west falls E, `$07` on the east
falls W, `$04` on the south falls N — all four pointing into the bowl. The
three empty columns on the left are outside the play area.

**Hole 56 `MAP70`** — a 12x24 staircase climbing elevation `$01` to `$0F`,
built almost entirely from the full-cell diagonal ramps `$18` and `$1B` with
a `07 07 01 05 05 01` landing row every fourth row. It is the clearest
demonstration that elevation is a plain per-cell integer and the shape id
only describes the tilt within each cell.

## Exporting

`tools/terrain.py --export` writes, per hole, a `geometry.json` giving every
cell's shape (with its family and fall direction), elevation, the four wall
flags, the layer-4 high nibble, gap flag, island id, special-tile id with the
handler's description and confidence, and the actor id from
`tbl_tile_actor $82:BDBC`. Solid cells also carry the four corner surface Z
values, computed with the same `surface_z` this document describes, so a
ramp is described by its actual heights rather than by its elevation byte
alone. A `heightmap.png` samples that surface 8x8 per cell, and
`build/courses/holes.tsv` summarises all of them.

```bash
python3 tools/terrain.py --export            # all holes
python3 tools/terrain.py --export --index 0
```

## Not established

- The **high nibble of layer 4** (`$10`-`$80`). `$80` is the most common
  non-zero value, and no read of it exists anywhere in banks `$80-$87`.
- **Slope acceleration.** No "add a constant to vx/vy because this is a
  slope" was found. `$81:9444` is called on landing with the surface shape
  code and indexes tables at `$81:9EB9`/`$81:9ED9`, which is the likely
  velocity-redirection path, but it was not decoded.
- `$82:B477` is indexed by a shape byte but has only 16 entries, and shape
  ids run to 27. Either the callers guarantee a small value or it is a latent
  bug; not resolved.
