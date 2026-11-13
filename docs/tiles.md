# Special tiles

Course grid layer 2 (`$7E:8390`, one byte per cell) is the special-tile layer:
hazards, friction changes, boost panels, enemies, and the per-hole marked
cell. This is what makes one patch of floor behave differently from another;
the *shape* of the floor is layer 1, written up in [terrain.md](terrain.md).

Reproduce everything below with `python3 tools/terrain.py --tiles`, and see
one hole's tiles with `--index N --legend`.

## Two tile layouts per course

Layer 2 is the *only* layer that distinguishes the two halves of the hole
table. The 232 populated slots are **116 terrain geometries, each stored
twice at index `i` and `i+64`**, with the same name: indices 0-63 and 64-127
are `MAP00`-`MAP77`, and 128-179 and 192-243 are `MAP80`-`MAPE3`. Between a
pair, **layers 1, 3 and 4 are byte-identical and only layer 2 differs** — the
same course furnished with a different set of hazards and enemies.

So counts here are over **hole slots**, not geometries. The 20 `MAPC0`-`MAPE3`
second copies carry a 16-byte stub layer 2 (a lone `$0C`) instead of a grid,
leaving **212 slots with a real tile layout and 7,947 non-zero cells**.

## The dispatcher

There is no interpretation of the byte at all — it is a jump table index.
`$81:811B (0x00811B)` is called with the layer-2 value of the cell the ball
just landed on:

```
$811B  CMP #$0100 / BCS $811E     ; trap: the value must fit in a byte
       STA $BC
       ASL A / CLC / ADC $BC      ; value * 3
       TAX
       LDA $81:8136,X / STA $BC   ; a 3-byte long pointer
       LDA $81:8137,X / STA $BD
       JML [$1EBC]                ; D = $1E00, so this is [$BC]
```

So **`$81:8136 (0x008136)` is a 256-entry table of 3-byte long pointers**, one
per possible tile value. A second, identical mechanism at
`$81:8436 (0x008436)` uses the table at `$81:8451 (0x008451)` when the ball
hits the cell from the side rather than landing on it.

The two tables **group the 256 values identically** — same 40 groups — but
point at different handlers, so every tile type has a distinct "landed on" and
"hit from the side" behaviour. Only 14 of the 256 entries are the same pointer
in both.

Call sites, both in the physics step `$81:801C`:

```
$80A2  LDA $DA0A / JSL $81:811B    ; landed on the cell
$8100  LDA $DA0A / JSL $81:8436    ; ran into it sideways
```

`$7E:DA0A` is the layer-2 byte under the ball, filled in by
`sub_terrain_probe` at `$81:94F0`.

## What the groups do

112 of the 256 values fall through to `$81:8905` (land) / `$81:8A56` (hit),
which is the ordinary "no special behaviour" path. The rest:

| values | on land | what it does |
|---|---|---|
| `$20-$24` | `$82:8F77` | **friction override** |
| `$04` | `$82:8EFB` | friction override, second variant |
| `$30-$3B` | `$82:9DB3`+ | **boost panel**, four directions |
| `$10-$13` | `$82:A7DD` | **kicker**: landing speed becomes a directional impulse |
| `$70-$7B` | `$82:9FD1`+ | toggled directional impulse, two magnitudes |
| `$18-$1B` | `$82:A5B1` | snaps Z to the surface and zeroes vz |
| `$80-$8F`, `$98-$A1` | `$82:98F8` | **hazard** |
| `$90-$97` | `$82:9653` | hazard |
| `$05` | `$82:A55E` | hazard; also snaps Z and zeroes vz |
| `$A2` | `$82:9858` | hazard (unused by any course) |
| `$AC-$AE` | `$82:86B9` | hazard, after restoring the previous position |
| `$40-$52`, `$57` | `$82:8967` | **spawns an actor** |
| `$02` | `$82:94D3` | solid object standing 3 height steps tall |
| `$28-$2D` | `$82:8FF1` | edge; falls through to `$81:899F`, keep falling |
| `$60-$6F` | `$82:80F6` | surface overlay, with enter/leave tracking |
| `$08` | `$82:AD8E` | **the cup**: holes the ball (docs/physics.md). In no course's data, because the cup is spawned at run time where the last enemy falls |
| `$14-$17`, `$1C`, `$1D`, `$58-$5D`, `$B0-$B9` | various | not established |

### Friction — `$20-$24`

`$82:8FA4` overwrites three coefficient slots in the active object:

```
if state == $0A: return
$DA3A = $80:DD7D                                  ; $0800 = 0.0625
if tile == $24: $DA3C = $80:DD7F (0.9799), $DA3E = $80:DD81 (0.9000)
else:           $DA3C = $80:DD83 (0.9990)
                $DA3E = $80:DD85 (0.9990), or $80:DD87 (0.8000) in state 6
```

The defaults these replace are `$80:DD11` = `$5332` (0.65) and `$80:DD15` =
`$6665` (0.80). `$DA3C` and `$DA3E` are the Q15 factors the landing code at
`$81:8975` applies on every bounce — **vx and vy are both scaled by `$DA3C`,
vz by `$DA3E`**, through the fixed-point multiply `$81:9793`:

```
$8975  LDA $D9D4 / LDX $DA3C / JSL $81:9793 / STA $D9D4    ; vx *= $DA3C
$8982  LDA $D9D6 / LDX $DA3C / JSL $81:9793 / STA $D9D6    ; vy *= $DA3C
$898F  LDA $D9D8 / LDX $DA3E / ...                         ; vz *= $DA3E
```

So raising `$DA3C` from 0.65 to 0.999 makes the ball keep almost all of its
horizontal speed on each bounce — a slippery or fast surface. `$24` is
deliberately less extreme than `$20-$23`.

### Boost panels — `$30-$3B`

Four handlers, each adding a fixed delta to one velocity component:

| handler | values | effect | direction |
|---|---|---|---|
| `$82:9DB3` | `$30 $35 $38` | `vy += $82:9CB7` = −512 | N |
| `$82:9DD7` | `$31 $37 $3A` | `vx += $82:9CB5` = +512 | E |
| `$82:9DFB` | `$32 $34 $39` | `vy += $82:9CB5` = +512 | S |
| `$82:9E1F` | `$33 $36 $3B` | `vx += $82:9CB7` = −512 | W |

The direction order is the same N/E/S/W used by the terrain edge table. Each
handler is gated by three tests (`$82:9E76`, `$9E85`, `$9E9A`) before it
applies the delta.

`$30-$33` sit on flat cells. `$34`, `$36`, `$38`, `$3A` sit **only on ramp
shapes** — `$34` on `$04`, `$36` on `$05`, `$38` on `$06`, `$3A` on `$07` —
and in every case the boost direction is the *uphill* direction of the ramp
it sits on. They are the panels that push you up a slope.

### Kicker — `$10-$13`

`$82:A7DD` fires only if the ball is at or below the surface. It scales the
landing vz through the multiply routine `$80:A342`, clamps it against
`$80:DDE3`/`$80:DDE5`, and converts the result into a vx/vy impulse whose
direction comes from the tile value. Landing harder throws you further.

### Hazards

Six groups end up calling **`$83:ABC5`** — the same routine the driver calls
at `$82:C092` when the ball falls out of the world entirely (see
[terrain.md](terrain.md)). So a hazard tile and a bottomless gap have the same
consequence; only the trigger differs.

## Two values found by scanning, not dispatch

At course load, `$82:ACBF (0x012CBF)` walks the whole grid row by row looking
for layer-2 byte **`$0C`** (or `$C3`), and records its column, row, cell index
and `elevation + 1`:

```
$ACD2  LDA $8390,X / CMP #$0C / BEQ $ACF9
       CMP #$C3 / BEQ $ACF9
```

`$0C` occurs **exactly once in every one of the 212 hole slots** that has a
layer-2 grid, and always on flat ground (`layer1 == $01`). Storing
elevation + 1 is where something *rests on top of* that cell. This is the
hole's single marked position; `$C3` is accepted by the same scan but appears
in no hole.

Note `$0C` is in the *default* dispatch group, so it has no landing behaviour
— it is purely a load-time marker.

## Actors

The load-time sweep `$82:B320 (0x013320)` visits every cell, and for a
non-zero layer-2 byte looks it up in a 256-entry word table at
**`$82:BDBC (0x013DBC)`**. `$FFFF` means "no actor" and the generic handler
`$82:BD5C` runs instead; otherwise `$82:B3AF` spawns one. Only 48 values map
to an actor:

```
$02          -> $0048        $80-$8F -> $004C        $AC -> $0051
$40-$52 $57  -> $0049        $90-$97 -> $004D        $AD -> $0052
                                                     $AE -> $0053
```

**An actor id is a thread object type** (docs/animation.md). `$82:B3AF`
passes it in A, unchanged, to `sub_thread_spawn_below $80:E4B6`, with the
cell's position in X/Y; `$8000` spawns nothing and records the cell only.
So `$0048` is object type 72, `$0049` type 73, `$004C`-`$004D` types 76-77
and `$0051`-`$0053` types 81-83, and their code and sprites are those
types' (`build/sprites/objects/obj_NNN.png`, and from live state
`build/sprites/emu/obj_NNN.png`). Independently confirmed by running all
232 holes (tools/snesstep/holes.py, tools/actorids.py): types 76, 77, 81,
82 and 83 are alive in exactly the holes whose layer 2 holds the matching
actor, an overlap score of 1.000 each.

`$40-$52` and `$57` all map to the *same* actor id, so the layer-2 byte itself
must carry the subtype — the sweep stores it at `$0C` before the lookup. These
20 values occur in **all 212 hole slots**, 2 to 11 per hole (most often 3 or
4), which is the right shape for the per-hole enemies.

## Correlation with the terrain layer

Some layer-2 values are locked to a layer-1 shape:

- `$61`, `$64`-`$6F` mirror the shape byte exactly — `$64` only ever appears
  on shape `$04`, `$65` on `$05`, and so on. The `$60-$6F` group is a surface
  overlay that needs the shape restated.
- `$20`-`$23` sit only on shapes `$04`-`$07`, and `$2A`-`$2D` mostly on the
  diagonal shapes `$10`-`$17`.
- Everything else sits overwhelmingly on flat ground (`$01`).

## Not established

- What the `$60-$6F` overlay *is*. Its handler `$82:80F6` tracks entering and
  leaving via `$69CA`/`$69D2`-`$69DA`, and it appears in 45 holes with 1,807
  cells — the second largest group. Mechanics traced, identity not.
- `$14-$17`, `$1C`, `$1D`, `$58-$5D`, `$B0-$B9`: handlers located, not read.
- The `$70-$7B` family's purpose. Twelve values in four groups of three,
  gated on a toggle at `$6A2A`, two impulse magnitudes (`$80:DDEF` = 4912 and
  `$80:DDF3` = 2456). Only four are used at all: `$74` (166 cells), `$75`
  (54), `$70` (3) and `$71` (2).
- ~~The actor ids~~ -- settled: an actor id is the thread object type
  `$82:B3AF` spawns (see Actors above). Which picture each of the 20
  `$0049` subtypes selects is decided inside type 73's code from the
  layer-2 byte saved at `$0C`.
- Whether the `$28-$2D` "edge" reading is right; it is inferred from the
  handler falling through to the gravity routine and from those values tracing
  the rim of the play area.
