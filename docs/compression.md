# HAL LZ compression

Every compressed asset in the ROM uses one format, decompressed by the
routine at `$80:9F18 (0x001F18)`. This is the same scheme HAL used across
their SNES/GB titles; Devin Acker's `exhal`/`inhal` implement it for other
games, and `tools/halcomp.py` implements it here.

Verified by disassembling `$80:9F18` with `tools/dis65816.py` and by
decompressing all 28 hard-coded call sites plus the 1,298 pointers in the
bank `$88` course tables without a single malformed stream.

## Calling convention

`JSL $80:9F18` with

| register | meaning |
|---|---|
| `A` (low byte) | source bank |
| `X` | source address |
| `Y` | destination address |

The destination bank is the data bank register at entry. Entry width is
`M=1, X=0` (8-bit A, 16-bit X/Y). The routine sets `D = $0000`, saves the
processor status, and returns with `RTL`.

Because `X` is the 16-bit output index, **a stream cannot produce more than
64 KB**, and copy offsets are relative to the destination base in `Y`, i.e.
to output byte 0.

A second entry point `$80:A206 (0x002206)` is a *resumable* variant: it
keeps its state in direct page `$AB`/`$AD`/`$AF` and decompresses at most
`$B1` bytes per call, so a large asset can be spread over several frames.
Same stream format.

## Stream format

A stream is a sequence of commands, ended by a `0xFF` byte.

```
command byte c
  c == 0xFF                     end of stream
  (c & 0xE0) != 0xE0            type = c & 0xE0
                                length = (c & 0x1F) + 1        (1..32)
  (c & 0xE0) == 0xE0            long form, one more byte n:
                                type = (c << 3) & 0xE0
                                length = (((c & 3) << 8) | n) + 1   (1..1024)
```

The long form re-uses the top three bits of `c` shifted left by three, so a
long command can express types `0x00`-`0xC0` but never `0xE0` itself.

| type | name | operand | output |
|---|---|---|---|
| `0x00` | literal | `length` bytes | copied verbatim |
| `0x20` | run | 1 byte | that byte, `length` times |
| `0x40` | run16 | 2 bytes | that pair, `length` times (`2*length` bytes) |
| `0x60` | ramp | 1 byte | `b, b+1, b+2, ...`, `length` bytes |
| `0x80` | copy | 2 bytes, **big-endian** offset | `length` bytes from `output[offset]` forward |
| `0xA0` | copy, bit-reversed | as above | same bytes, each bit-reversed (`0x80`↔`0x01`) |
| `0xC0` | copy backwards | as above | `output[offset], output[offset-1], ...` |

The three copy commands take their offset **big-endian**, unlike every other
16-bit value in the ROM. `$80:9FC2` does `LDA [$A2],Y / XBA` to swap the
bytes, which is what gives it away.

The bit-reversed copy (`0xA0`, code at `$80:9FF0`) is the format's
signature trick: it reverses a byte by rotating through a scratch byte eight
times. It exists so that a mirrored graphics tile costs a copy command rather
than fresh literals.

## Where compressed data lives

Two kinds of call site:

**Hard-coded**, 28 `JSL $80:9F18` sites, 14 with immediate operands. These
are the fixed screens:

| source | dest | unpacked | what |
|---|---|---|---|
| `$8E:EC7F (0x076C7F)` | `$7F:7800` | 6,656 | title screen tiles |
| `$8D:9400 (0x069400)` | `$7F:E000` | 6,848 | title screen tiles |
| `$8F:E6A4 (0x07E6A4)` | `$7F:1FC0` | 4,160 | title screen tiles |
| `$92:8FDE (0x090FDE)` | `$7E:8BB0` | 4,096 | overwrites the course row-offset table; purpose unknown |
| `$93:E7D5 (0x09E7D5)` | `$7E:39DA` | 2,144 | tileset loader entry 6 |
| `$93:E1B6 (0x09E1B6)` | `$7E:39DA` | 2,880 | tileset loader entry 23 |
| `$93:CE8D (0x09CE8D)` | `$7E:DADC` | 1,466 | a course backdrop tilemap; `$7E:DADC` is staged then DMA'd to VRAM `$3C00` by `$80:D7AC` |
| `$94:F222 (0x0A7222)` | `$7E:DADC` | 2,048 | the same, on the `$7E:ED5B` variant path in `$80:D6A8` |

All but the first are now accounted for: three are reached from the tileset
jump table or the backdrop loader, which `tools/scenes.py loaders` walks —
see [scenes.md](scenes.md). Only `$92:8FDE` is still unexplained, and it is
notable because `$7E:8BB0` is where course table 7 (the row-offset
directory) lives, so something else reuses that buffer.

**Table-driven**, the course data in bank `$88` — see
[courses.md](courses.md).

**Not compressed at all.** Some graphics never pass through this
decompressor: a VRAM record block whose source is a ROM bank rather than
`$7E`/`$7F` is a direct ROM-to-VRAM DMA. Nine tileset loader entries work
that way, with sources in banks `$8D` and `$91`-`$94`. A stream scan will
never find those assets, so the loader walk in
[scenes.md](scenes.md) is the only way to reach them.

## Scanning for streams

`tools/halcomp.py --scan` brute-forces every offset. A stream is accepted
when it decodes cleanly, terminates, produces at least `--min-out` bytes and
compresses by at least `--min-ratio`. Over the whole ROM that finds ~2,200
non-overlapping streams.

The ratio filter is doing real work: a run of bytes that happen to look like
literal commands "decompresses" to itself at ratio 1.0, so without it the
scan reports thousands of false positives in code. Even with it, treat the
scan as a lead generator. A stream that no pointer or call site references
may be an accident of alignment. The verified inventory is the call sites
above plus the bank `$88` tables.
