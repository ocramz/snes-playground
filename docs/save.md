# The save: the battery RAM and the engine's JSON

The cartridge keeps 8 KB of battery RAM at `$70:0000`-`$70:1FFF`. Read for
port_v2 phase 7 (2026-11-16; notes/port-v2-phase7-shell.md) from the
routines that write it, and checked on the saves that
tools/snesstep/autoplay.py's runs leave (`build/emu/autoplay/*/sram.bin`).
The engine keeps the same content as JSON (`engine/src/core/save.ts`, the
user's choice); `tools/sram.py` decodes a game's `sram.bin` into that JSON,
and `engine/test/save.test.ts` replays five runs through the engine's rules
and gets the game's saves.

## The layout

| address | what | written by |
|---|---|---|
| `$70:0010` + 2m | member m's next course to clear (0-8; 15 in the extra game); `$9999` = no member | `$81:FA9B` (0 at creation), `$81:C714`/`$81:C6FA` (a course cleared) |
| `$70:001A` + 2m | its flags: bit 0 and bit 1 the map's and the extra map's first visit (`$83:9845`), bit 2 the eight courses cleared, bit 3 the extra eight | `$83:9857`, `$81:C6DB`, `$81:C705` |
| `$70:0024` + 2m | its serial: `$70:1B3C` when it was made | `$81:FAA3` |
| `$70:002E` + `$81:F1C9`[m] | its drawing, 48 words (NAME ENTRY's) | `$81:FA7A` (cleared), `$81:E0E1` |
| `$70:020E` + 2m | its checksum, `$81:C4B7` | `$81:C47B`, `$81:C55D`, `$81:FAB5` |
| `$70:0218` + 64m + 4c | course c's rounds (the times started, below 1000) | `$81:C52D` (after the course's intro) |
| `$70:021A` + 64m + 4c | course c's best medal, 0-3 | `$81:C6AE` |
| `$70:0358` + 350c + 14k | course c's ranking, 25 records of 14 bytes: the member, the score (word), the rounds (word), an order byte, the 8 holes' strokes; `$4444` = empty | `$81:CA5E`-`$81:CA88` |
| `$70:1938` | 16 words, cleared on a fresh save | `$81:C45F` |
| `$70:1958` + 30c | course c's merged order (saved and built-in records) | `$81:CAA7` |
| `$70:1B38` | the number of members | `$81:FABE` |
| `$70:1B3C` | the next serial (1 on a fresh save) | `$81:C440`, `$81:FAA8` |
| `$70:1B56` | `$EEFE`, a signature | `$82:F60D` |

Courses are `$6A5A`: 0-7 the eight courses, 8-15 the extra game's. The
checksum sums the member's 32 course words, its `$001A` and `$0010`, the
seven words of each of its ranking records, plus `$1357`; `$81:C494` checks
all five at the title and `$81:C562` resets a member that fails.

## The rules

- **A new member** (`$81:FA49`): at most five; the first empty slot; its
  drawing cleared, NAME ENTRY; cleared 0, the serial, the checksum.
- **A course started** (`$81:C52D`): its rounds + 1.
- **A course finished** (`$81:C666`, at the last hole's hole-out, 1P):
  - the holes' strokes capped at 99, their sum the score (`$D7E0`);
  - the medal: how many of the course's thresholds (`$81:C735` + 4c,
    bronze, silver, gold; course 1: 26, 19, 14) are ≥ the score; stored if
    better (`$EC4B` bit 0);
  - when the course was the member's next: cleared + 1 (`$EC4B` bit 1); at
    8, cleared 8 and flag bit 2 (bits 1-2); at 16 flag bit 3, the count
    stays 15;
  - the ranking (`$81:C8C6`): the round enters if it beats the 25th saved
    record (by score, then rounds); the 24 best saved, the new one (order
    id 25) and the course's five built-in records (`$81:CAB7`: members 5-9,
    ids 40-44; course 1's scores 19, 23, 27, 31, 35) are sorted by score,
    rounds, id; the members' records are kept in that order (`$EC4B` bit 3,
    `$EC4D` the new one's place).

## The engine's JSON

```
{ version: 1,
  members: [ null | { cleared, flags, serial, courses: [ { rounds, medal } x 16 ] } x 5 ],
  serial,
  rankings: [ [ { member, score, rounds, holes: [8] } ... ] x 16 ] }
```

Not kept: the checksums, the drawings (the engine skips NAME ENTRY: every
drawing is blank), `$70:1938`, the merged order and the order bytes (they
follow from the records), the member count. The host keeps it in
localStorage (`kdc-engine-save-v1`; docs/engine.md).
