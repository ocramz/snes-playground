# Graphics: tiles, tilemaps, palettes, sprites

All bulk graphics are HAL-compressed; see [compression.md](compression.md).

## Tile format

Standard SNES planar. `tools/tiles.py` decodes 2, 4 and 8 bpp. A 4bpp tile
is 32 bytes: 16 bytes of planes 0/1 interleaved per row, then 16 bytes of
planes 2/3. Bit 7 of a plane byte is the leftmost pixel.

```bash
python3 tools/tiles.py build/gfx/bin/076C7F_8EEC7F.bin --bpp 4 -o out.png
python3 tools/tiles.py build/gfx/bin/x.bin --bpp 4 --palette PAL.bin:3 -o out.png
```

## Tilemaps

One 16-bit little-endian word per 8x8 cell:

| bits | field |
|---|---|
| 0-9 | tile index |
| 10-12 | palette |
| 13 | priority |
| 14 | horizontal flip |
| 15 | vertical flip |

`tools/tilemap.py` renders a map over a tile sheet. The map's width is not
stored with the data, so pass `--width`; `--guess` lists the factorisations
that give a screen-shaped result.

The course backgrounds (bank `$88` tables 8 and 9) are the largest tilemaps,
704 to 16,880 bytes each.

## Palettes

CGRAM entries are 15-bit `0BBBBBGGGGGRRRRR` little-endian words. The game
stages a full 512-byte CGRAM image at `$7E:0400-$05FF` and DMAs it to
`$2122` in `sub_dma_cgram` at `$80:8250 (0x000250)`; the DMA parameter table
is at `$80:8288`. Palettes reach that buffer from ROM via `MVN`, so they are
stored raw and can be scanned for.

```bash
python3 tools/palettes.py scan '$98:8000' '$98:FFFF'
python3 tools/palettes.py render '$98:C000' 0x200 -o build/pal/x.png
```

The scan is a heuristic (16 aligned words, bit 15 clear, at least 6 distinct
colours). Look at the swatch before trusting a hit.

## Sprites

`tools/sprites.py`. Objects are drawn as metasprites: a list of 5-byte
part records walked by the OAM builder at `$80:8D89 (0x000D89)`.

| byte | meaning |
|---|---|
| 0 | Y offset, signed; added to the object Y at `$38`. `$7E` and `$80` are control codes |
| 1 | tile number, low 8 bits |
| 2 | OAM attribute `vhoopppN`: bit 0 is tile bit 8, bits 1-3 palette, 4-5 priority, 6 hflip, 7 vflip |
| 3 | X offset, signed; added to the object X at `$36` |
| 4 | bit 7 = last record in the frame, bit 6 = sprite size bit |

Bytes 1 and 2 are fetched as a single 16-bit load and stored straight into
OAM bytes 2-3. The X 9th bit and the size bit are accumulated two at a time
in `$31` and flushed to the OAM high table every four sprites, which is why
`$31` is initialised to `$80`.

Frame lists live in bank `$89`, reached through a word pointer table at
`$89:8000 (0x048000)` (105 entries, many `$FFFF` = unused). An object's
current list is stored per-object at `$7E:0B9E,X` with its bank at
`$7E:0BBE,X`, written by `$80:9B98 (0x001B98)`.

```bash
python3 tools/sprites.py --table
python3 tools/sprites.py --list '$89:8550'
python3 tools/sprites.py --render '$89:8550' TILES.bin -o build/frame.png
```

### OAM priority queues

`$80:8B02 (0x000B02)` dispatches on `$7E:2880` into one of ten queues, each
a triple of parallel arrays in `$7E:2884` upward with its own count. The
builder at `$80:8C08` drains all ten in order into the OAM staging buffer at
`$7E:0600`, so the queue number is the object's draw priority. Buffer
pointers are initialised by `$80:8823 (0x000823)`: OAM low table at `$0600`,
high table at `$0800`.

## Batch extraction

```bash
python3 tools/extract_gfx.py
```

Scans the ROM for streams (cached in `build/gfx/streams.tsv`), decompresses
each to `build/gfx/bin/`, renders PNGs to `build/gfx/png/`, and writes
`build/gfx/index.tsv` classifying each one.

Current counts over 2,227 streams:

| kind | count |
|---|---|
| data | 1,276 |
| tilemap | 671 |
| tiles2 | 165 |
| tiles4 | 110 |
| palette | 5 |

The classifier is a heuristic and it is wrong sometimes. Tilemaps are
detected by the concentration of their high 6 bits (palette/priority/flip
take only a handful of values); 4bpp is separated from 2bpp by how much the
upper bit planes overlap the lower ones. Small blobs like the 144-byte
course grids fall into `tiles2` because there is not enough data to judge.
Always open the PNG.
