# Text: the font encoding and where the strings are

The game stores no ASCII. A character **is** the index of its glyph tile in
the BG3 font, so the encoding does not have to be guessed from sample
strings — it can be read straight off the font sheet.

```bash
python3 tools/text.py --font-sheet -o build/text/font.png   # the encoding itself
python3 tools/text.py --strings                             # every string
python3 tools/text.py --render '$88:DA2F' -o build/text/x.png
python3 tools/text.py --decode 23 2F 2E 34 29 2E 35 25      # -> CONTINUE
```

## The font

`gfx_course_font` at `$90:FBBC (0x087BBC)` is a HAL stream that unpacks to
3,328 bytes, of which 3,072 are uploaded to VRAM word `$4000` as 192 2bpp
tiles by graphics set B entry 1 (`$80:CDE3`). Screen block 0 gives BG3 that
same character base, so glyph index = tile index. Laid out 16 to a row:

| range | glyphs |
|---|---|
| `$00` | blank |
| `$01-$0F` | `#` `%` `(` `)` `*` `/` `:` `.` `!` `<` `=` `>` `?` `[` `]` |
| `$10-$19` | `0`-`9` |
| `$1B-$1D` | `±` `+` `-` |
| `$1E` | solid block |
| `$1F` | **space** |
| `$20` | `@` |
| `$21-$3A` | `A`-`Z` |
| `$3B-$3F` | 字 左 右 上 下 |
| `$40` | the menu cursor, a right-pointing triangle |
| `$41-$45` | `°` `「` `」` `、` `･` |
| `$51-$6A` | `a`-`z` |
| `$6B`, `$6C` | `,` `'` |
| `$6D` on | empty boxes, unused |

Two things that earlier notes left open are settled by the sheet. The digits
really are `$10-$19` — that was previously marked "unconfirmed, by analogy".
And **space is `$1F`**, not `$00`; `$00` is a blank tile as well, but strings
use `$1F`.

## Control codes

`sub_text_draw` at `$83:B406 (0x01B406)` walks a string byte by byte. A byte
below `$F0` is a glyph: the routine ORs `$3C00` into it — palette 7 with the
priority bit set — and stores the word into the BG3 tilemap staging buffer at
`$7E:DADC`, advancing the column and wrapping when it reaches the line width
in `$0A`. A byte of `$F0` or above is dispatched through
`tbl_text_control $83:B46A`, sixteen word targets for `$F0-$FF`:

| code | target | meaning |
|---|---|---|
| `$FE` | `$83:B44C` | newline: advance the row, reset the column to the margin in `$08` |
| `$FF` | `$83:B49C` | end of string |
| `$F6-$FD` | `$83:B48A` | eight variants of the same handler; not read |
| `$F0-$F5` | `$83:B49C` | same target as `$FF` |

`$7E` has its own handler at `$83:B42A` which writes at `X - $42`, a
backward reference rather than a plain glyph; what it is for is not
established.

The pause menu at `$83:AFE4 (0x01AFE4)` shows the shape of a string:

```
FE 1F 1F 1F 1F 40 1F 23 2F 2E 34 29 2E 35 25 FE
\n  four spaces  cursor  space  C  O  N  T  I  N  U  E  \n
```

## Finding strings

`tools/text.py --strings` accepts a run that ends in `$FF`, holds at least
`--min` letters or digits, and is majority letters once spaces are
discounted. That last condition is what makes the scan usable: the
punctuation glyphs live at `$01-$0F`, which is exactly what a jump table of
small numbers looks like, so judging a run by its glyphs alone reports every
table in the ROM as prose. Even so the output has some false positives in
banks `$84`-`$85`; open one before trusting it.

315 strings come out, and they are mostly clustered:

| where | what |
|---|---|
| `$83:AFE4`-`$83:B08D` | the pause menu, three variants |
| `$83:BC86`-`$83:BDC6` | title and options menus: `PLAY GAME`, `2PLAY GAME`, `DEMO PLAY`, `MAP SELECT`, `SOUND ROOM`, `DANCE SELECT`, `DANCE01`-`DANCE08`, `DRAW DANCE`, `NORMAL COURSE`, `EXTRA COURSE`, `FGM:000`, `BGM:000` |
| `$83:FB02`-`$83:FDBD` | six ending messages, by medal tier and by normal or EXTRA course |
| `$88:DA16` on | the tutorial: `Basic Rule`, the shot panel, the power meter, enemies becoming the cup, scrolling and the guide |

The `SOUND ROOM` labels `BGM:000` and `FGM:000` are worth noting for the
audio work: the game has a sound test, so the song and effect id spaces are
both reachable in-game.

No string *pointer table* has been located yet. The strings are found by
scanning, and the code that selects one for a given screen has not been
traced, so a string cannot yet be attributed to the moment it appears.
