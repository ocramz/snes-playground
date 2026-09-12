# Audio: N-SPC driver, samples, and music

The game uses the N-SPC (Nintendo/HAL) sound driver. The strings
`nintenhalken` at `0x000ECC` and `*Ver S1.20*` at `0x0033C9` identify it,
and the second string also appears at SPC offset `0x112D` inside the
uploaded driver image, confirming the driver in ROM is that version.

`tools/spc_extract.py` extracts everything below. `tools/nspc.py` parses
the sequences, `tools/dis_spc700.py` disassembles the driver, and
`tools/brr.py` decodes samples.

Driver routines are cited by their **SPC** address throughout. The image is
loaded to SPC `$0800` from `$80:AA9D (0x002A9D)`, so the ROM address of any
of them is `0x002A9D + (spc - 0x0800)`; the table at the end of
[Sequence format](#sequence-format) lists the ones that matter both ways.

## Upload path

Three routines, all in bank `$80`, drive the APU.

### 1. IPL boot upload — `sub_spc_ipl_upload` at `$80:AA30 (0x002A30)`

The classic SNES IPL handshake: wait for `$AA`/`$BB` on ports 0/1, write the
destination to `$2142`, `$CC` to port 0, then stream bytes. Its block table
is at `$80:AA99 (0x002A99)` and holds exactly one block:

```
len $0A0B   dest $0800      2,571 bytes -> SPC $0800
len $0000   entry $0800     terminator; the address field is the entry point
```

So the driver image is `0x002A9D..0x0034A8` in the ROM, and it runs from
SPC `$0800`.

### 2. Init-set upload — `sub_spc_upload_set` at `$80:B651 (0x003651)`

Takes a set number in `A`, indexes the pointer table at
`$80:B729 (0x003729)`. Each entry points to a list of long pointers
(`addr16, bank16`), zero-terminated; each of those points to a block chain.

| set | source | dest | bytes | contents |
|---|---|---|---|---|
| 0 | `$95:8000 (0x0A8000)` | `$8200` | 32,016 | BRR sample data |
| 0 | `$96:8000 (0x0B0000)` | `$3B00` | 10,754 | song pointer table + SFX sequences |
| 0 | `$96:AA08 (0x0B2A08)` | `$0400` | 320 | sample directory |
| 1 | `$95:FD16 (0x0AFD16)` | `$0600` | 468 | instrument table |
| 1 | `$95:FEF0 (0x0AFEF0)` | `$03E0` | 24 | volume/velocity curve |

### 3. Song upload — `sub_spc_upload_song` at `$80:B69B (0x00369B)`

`A` = song number, indexes `$80:B745 (0x003745)`, 4 bytes per entry
(`addr16, bank16`). Every song is a single block loaded to SPC `$6502`.
After uploading, the SNES writes the **song id** to port 0, where
`id = 0x7E + n`. The driver's song-start code at SPC `$1168` reads its
pointer from `$3AFE + 2*id`, i.e. from the song table inside the `$3B00`
block.

33 songs, `n = 0..32`, ids `$7E..$9E`, spanning `0x0B2B4E` to `0x0C3C04`
across banks `$96`-`$98`. Sizes range from 77 bytes (song 0) to 7,270
(song 2).

## Block chain format

Shared by all three uploaders:

```
len16  addr16  <len bytes of data>     repeat
0x0000 addr16                          terminator
```

In the IPL table the terminator's address field is the SPC entry point; in
the others it is ignored.

## Samples

The sample directory at SPC `$0400` is 80 entries of 4 bytes: start
address, loop address. Many entries are duplicates pointing at the same
sample with different instrument settings, so there are 25 distinct
samples, all inside the `$8200` BRR block.

BRR is 9-byte blocks: header (shift, filter, loop flag, end flag) then 16
4-bit nibbles. `tools/brr.py` implements the four filters with the DSP's
clamping. Decoded WAVs are written at 32 kHz, the DSP's native output rate;
actual playback pitch is per-note, so a WAV is a reference rendering, not
the pitch you hear in game.

The instrument table at `$0600` is 6 bytes per entry, 78 entries:

```
sample#  ADSR1  ADSR2  GAIN  pitch_hi  pitch_lo
```

Entry 0 is `00 FF F3 B8 01 A0`. The `B8` in every entry is the GAIN byte,
constant across the table.

SPC `$0BCB` is what proves the layout: it multiplies the instrument index
by 6, adds `$0600`, then writes bytes 0-3 straight to DSP `$x4`-`$x7`
(SRCN, ADSR1, ADSR2, GAIN) for the voice, and keeps bytes 4-5 as a 16-bit
**big-endian** pitch scaler in `$0220+X` (`$0C16`: byte 4 goes to the high
half). The scaler is 8.8 fixed point — `$0100` is unity — and the observed
range is `$0100`-`$07A0`.

Two details that only show up in the code:

* A sample number with **bit 7 set means noise**, not a sample: `$0BF4`
  branches on it, masks the low 5 bits into the FLG noise clock and sets
  this voice's bit in the DSP `NON` register. No instrument in this ROM
  uses it — every entry's sample number equals its own index, 0 to 77.
* An `$E0` **argument of `$80` or more is a percussion instrument**, not a
  direct index: `$0BCF` branches on bit 7 and computes `$5F + (arg - $CA)`,
  the same arithmetic the `$CA`-`$DF` percussion notes use. Songs here use
  `$CA`-`$D5`, which with the only percussion base in the game (`$42`,
  set by the `$FA` command) resolves to instruments 66-77.

`build/spc/instruments.tsv` has all 78 rows with ADSR and GAIN decoded,
`build/spc/samples.tsv` the 80 directory entries cross-referenced to the
instruments that use them, and `build/spc/curve.tsv` the 24 gate/velocity
values.

## Playable .spc files

`tools/spc_extract.py` writes a `.spc` per song without needing an
emulator, by assembling RAM exactly as the game does and letting the driver
initialise itself:

* RAM = driver + init set 0 + init set 1 + the song block at `$6502`
* PC = `$0800`, SP = `$CF` (the driver's own `MOV X,#$CF / MOV SP,X`)
* DSP `DIR` = `$04` (page of the sample directory)

The one patch: the driver polls the APU ports at SPC `$08B6`
(`MOV A,$F4+X / CMP A,$F4+X / BNE`), which in a static rip never changes.
Those six bytes are replaced with `MOV A,$05F0+X` plus three `NOP`s, and a
constant table `[song_id, 0x00, 0xFF, 0x00]` is planted at `$05F0`. The
driver then reads "song `$7E` requested, volume `$FF`" on its first poll and
starts playing. `make_spc` asserts the original six bytes before patching,
so a changed driver fails loudly instead of producing silence.

This is a deliberate deviation from the ROM's own bytes and the reason the
files play standalone. If a player renders silence, suspect the patch first.

Every file requests id `$7E` whichever song it contains. That is correct,
and it is what the game itself does: `$80:B4DC` loads `#$007E` literally
after `sub_spc_upload_song` returns, whatever song number it was given.
The driver looks a sequence pointer up at SPC `$3AFE + 2*id`, and the
`$7E` slot holds `$6502` — the fixed address every song is uploaded to.
Requesting a song's own id would index the table with `2*(id & $7F)` and
land on a **sound effect**: id `$84` (song 6) would read the slot for
effect `$04`.

## Sequence format

Songs and sound effects are the same format, read by the same routines.
Everything in this section was read out of the driver image rather than
assumed from N-SPC in general; `tools/nspc.py` implements it and its
module docstring repeats the citations.

### Lookup

SPC `$1168` is the one sequence-start routine. It takes an id in `A`,
doubles it and reads a 16-bit pointer from `$3AFE + 2*id`. The doubling is
a plain `ASL A` (`$1143` on the port-1 path, `$09CE` on the port-0 one),
which also **discards bit 7** — that bit is the SNES's retrigger toggle,
not part of the id.

| id | pointer |
|---|---|
| `$00` | `$0000`, "stop" — two RAM bytes below the block, always zero |
| `$01`-`$7D` | a sound effect inside the uploaded `$3B00` block |
| `$7E` | `$6502`, wherever `sub_spc_upload_song` just put a song |

There is no `$7F` entry: `$3AFE + 2*$7F` = `$3BFC`, which is already the
first word of sound effect 1's word list. The table proper is 126 entries,
`$3B00`-`$3BFB` (`$96:8004`-`$96:80FF`), and sequence data starts at
`$3BFC` (`$96:8100`).

### Word list, patterns, tracks

A pointer from that table addresses a **word list**. SPC `$09B9` reads one
word and advances by two; `$0A43` dispatches on it, and because `$09B9`
leaves the flags from `MOV Y,A` on the *high* byte, the test is on the high
byte alone:

```
high byte != 0      the word points at a pattern
word == $0000       end of song: $09CC restarts the sequencer with id 0
otherwise           the low byte is a repeat count and the NEXT word is
                    the address the list jumps back to ($0A4B-$0A5A,
                    counter in $42)
```

A **pattern** is 8 consecutive 16-bit track pointers, one per DSP voice —
`$1183` and `$0A63` both step `X` by 2 through a rotating voice mask in
`$47`. A track pointer whose **high byte is zero** means the voice is
unused for that pattern, and `$0A87` keys it off.

The song advances to the next word as soon as *any* track reaches its
end-of-track byte (`$0AC0` → `$0A5A` → `$0A43`), so patterns have no length
of their own.

Track pointers within a pattern regularly **overlap**: song 0's voices 1-4
point at successive `$EF` commands in the same four-command run so the
same subroutine plays 4, 3, 2 and 1 times. Parsing each track separately
therefore counts shared bytes more than once, which is why
`summary.tsv`'s event counts exceed what the byte counts suggest.

### Event grammar

Bytes are fetched one at a time by SPC `$0BC1` and classified at `$0AF1`.

| byte | meaning | where |
|---|---|---|
| `$00` | end of track | `$0ABA` |
| `$01`-`$7F` | note duration in ticks, kept in `$0200+X` | `$0AF3` |
| `$80`-`$C7` | note; pitch index = `byte & $7F` | `$08D3` |
| `$C8` | tie | `$08C8`, `$0F5A` |
| `$C9` | rest | `$08C8`, `$0F62` |
| `$CA`-`$DF` | percussion note | `$08BF` |
| `$E0`-`$FA` | command, argument count from `$0E54` | `$0B13` |
| `$FB`-`$FF` | **invalid** — the jump table is only 27 entries wide | `$0E1E` |

After a duration byte, if the **next** byte is also below `$80` it is a
gate/velocity byte rather than a new event: `$0AFC` swaps its nibbles and
masks 3 bits to index the 8 gate values at `$03E0`, and masks the low
nibble to index the 16 velocity values at `$03E8`. Both persist until
changed, as does the duration. The gate scales the duration into a key-off
tick (`$0B25`: `duration * gate >> 8`, minimum 1).

`$C8` and `$C9` both return from `$08BF` without a key-on, so neither
starts a note. They differ only in the look-ahead at `$0F34`, which scans
forward when a note's gate expires: it finds `$C8` and skips the key-off
(the note holds), and keys off for everything else including `$C9`.

Percussion notes set the instrument themselves — `$08C3` calls `$0BCB`
with the event byte, which resolves to `$5F + (byte - $CA)` — and then
force pitch index `$A4 & $7F` = `$24` for every one of them.

Notes are absolute: pitch index (0-71) plus the global transpose `$50` and
the per-track transpose `$02F0+X`. The conversion at `$0940` divides the
index by 12 to get an octave, looks the semitone up in a 13-entry table at
`$1112` (an equal-tempered octave; entry 12 is exactly double entry 0), and
shifts by `octave - 5`. The **absolute** octave cannot be pinned down
statically, because each instrument's 8.8 pitch scaler compensates for
whatever rate its sample was recorded at — `nspc.py --note-base` exists for
that reason and defaults to putting note 0 at MIDI 24.

### Commands

Two tables, adjacent in the driver:

* **`$0E1E`** — 27 handler addresses, indexed by `$0D5E + ((2*cmd) & $FF)`.
* **`$0E54`** — 27 argument counts, indexed by `$0DF4 + (cmd - $80)`.

The dispatcher at `$0BAF` only tests the count for zero (it pre-fetches one
argument byte and lets the handler fetch the rest), so on its own it would
not prove the counts. The note look-ahead does: `$0F69` **adds** the same
table entry to step over a whole command, reaching it as `$0D74 + cmd`.
Both index expressions land on `$0E54`, and every handler's own fetches
were counted and agree.

| cmd | args | name | handler | what the handler does |
|---|---|---|---|---|
| `$E0` | 1 | instrument | `$0BCB` | index*6 + `$0600`; bytes 0-3 → DSP `$x4`-`$x7`, 4-5 → pitch scaler. Arg ≥ `$80` is percussion-relative |
| `$E1` | 1 | pan | `$0C24` | raw → `$0351+X`, low 5 bits → `$0331+X`; bits 7-6 are phase-invert flags |
| `$E2` | 2 | pan fade | `$0C32` | duration, target; slope → `$0340+X` |
| `$E3` | 3 | vibrato on | `$0C4B` | delay `$02B0+X`, rate `$02A1+X`, depth `$B1+X` |
| `$E4` | 0 | vibrato off | `$0C57` | the same three cleared (entered with `A` = 0) |
| `$E5` | 1 | master volume | `$0C72` | `$59` |
| `$E6` | 2 | master volume fade | `$0C77` | slope → `$5C`, applied at `$0B4C` |
| `$E7` | 1 | tempo | `$0C89` | `$53`; tick rate = 500 Hz × tempo/256 |
| `$E8` | 2 | tempo fade | `$0C8E` | slope → `$56` |
| `$E9` | 1 | global transpose | `$0CA0` | `$50`, added to every note at `$08D6` |
| `$EA` | 1 | track transpose | `$0CA3` | `$02F0+X`, added at `$08D9` |
| `$EB` | 3 | tremolo on | `$0CA7` | delay `$02E0+X`, rate `$02D1+X`, depth `$C1+X` |
| `$EC` | 0 | tremolo off | `$0CB3` | depth cleared |
| `$ED` | 1 | track volume | `$0CD4` | `$0301+X` |
| `$EE` | 2 | track volume fade | `$0CDD` | slope → `$0310+X` |
| `$EF` | 3 | call | `$0CFA` | `addr16`, repeat count; saves `$30/$31+X` to `$0230+X`, returns at `$0ADA` |
| `$F0` | 1 | vibrato fade-in | `$0C62` | depth/duration → `$02C0+X`, a per-tick ramp |
| `$F1` | 3 | pitch slide up | `$0CB6` | delay, duration, semitones; target = note + semitones |
| `$F2` | 3 | pitch slide into note | `$0CBA` | same args, but `$0912` first drops the note by `semitones` and slides up into it |
| `$F3` | 0 | pitch slide off | `$0CD0` | `$0280+X` = 0 |
| `$F4` | 1 | fine tune | `$0CF6` | `$0381+X`, the fractional part of the pitch (`$08DF`) |
| `$F5` | 3 | echo on | `$0D1D` | voice mask `$4A`, volumes `$61`/`$63`, clears FLG bit 5 |
| `$F6` | 0 | echo off | `$0D51` | volumes zeroed, FLG bit 5 set |
| `$F7` | 3 | echo parameters | `$0D58` | delay → `EDL` via `$0D7A`, feedback → `$4E`, preset*8 indexes the FIR table at `$10DE` |
| `$F8` | 3 | echo volume fade | `$0D30` | duration, target L, target R |
| `$F9` | 3 | pitch slide to note | `$0DCF` | delay, duration, absolute note; also pre-scanned right after a note at `$0DC5` |
| `$FA` | 1 | percussion base | `$0DBC` | `$5F`, the instrument `$CA` maps to |

Names are descriptions of what each handler was observed to do. Two
qualifications:

* **`$F1` vs `$F2`** is a mechanism difference, not a direction one. Both
  slide upward for a positive argument; `$F1` starts at the written note
  and ends `semitones` above it, `$F2` starts `semitones` below and ends on
  it. The conventional N-SPC names "slide up" / "slide down" are how other
  drivers in the family label these opcodes — **unconfirmed** for this one.
* **`$E3`/`$EB` argument order** (delay, rate, depth) follows the order the
  handler stores them in. Which stored variable the per-tick code treats as
  rate and which as depth was not traced, so the two could be swapped.

### Driver routines

| SPC | ROM | what |
|---|---|---|
| `$08B2` | `$80:AB4F (0x002B4F)` | APU port mirror; `$08B6` is the six bytes `make_spc` patches |
| `$08BF` | `$80:AB5C (0x002B5C)` | note/tie/rest/percussion handler |
| `$09B9` | `$80:AC56 (0x002C56)` | read the next word of a word list |
| `$09CC` | `$80:AC69 (0x002C69)` | start the sequence named by port 0 |
| `$0A22` | `$80:ACBF (0x002CBF)` | sequencer tick: port 0, song advance, per-voice events |
| `$0BAF` | `$80:AE4C (0x002E4C)` | command dispatch |
| `$0BC1` | `$80:AE5E (0x002E5E)` | fetch one track byte |
| `$0BCB` | `$80:AE68 (0x002E68)` | set instrument (also the percussion path) |
| `$0E1E` | `$80:B0BB (0x0030BB)` | command handler jump table, 27 entries |
| `$0E54` | `$80:B0F1 (0x0030F1)` | command argument counts, 27 entries |
| `$0F34` | `$80:B1D1 (0x0031D1)` | key-off look-ahead; the second reader of `$0E54` |
| `$10DE` | `$80:B37B (0x00337B)` | echo FIR coefficient presets, 8 bytes each |
| `$1112` | `$80:B3AF (0x0033AF)` | semitone pitch table, 13 entries, octave 5 |
| `$1137` | `$80:B3D4 (0x0033D4)` | port 1 poll: start or stop a sound effect |
| `$1168` | `$80:B405 (0x003405)` | start a sequence from an id |

## Sound effects

125 of them, ids `$01`-`$7D`, living in the same `$96:8000` block as the
sequence pointer table and read through the same `$3AFE + 2*id` lookup and
the same `$1168` start routine. `tools/nspc.py --all` parses every one.

An effect is always a **single pattern**: `$1168` treats the first word of
the word list as a pattern pointer and copies its 8 track pointers straight
into the voices, without the word-list walk songs get. It also sets each
voice's bit in `$22`, the "owned by a sound effect" mask, which makes the
song code skip those voices when it loads a pattern (`$0A63`, `$0A81`).
When such a track hits `$00` the driver releases the voice and clears the
bit (`$0AC6`) instead of advancing a song.

In practice the music uses DSP voices 0-4 and effects use 5-7.

### The SNES side

`sub_spc_sfx_trigger $80:B542 (0x003542)` is a `JSL` taking the id in a
16-bit `A` (it does `TAX` with `X` 16-bit, and `$80:B5A9` masks a table
read with `#$00FF`). It returns the id, or `$FFFF` if the request was
refused.

```
id == 0        clear the three slot states at $1008/$100A/$100C and send 0
$1014 != 0     refuse: sound effects are disabled
otherwise      tbl_sfx_slots[id] is a 3-bit mask of which slots may be used;
               for each bit, compare tbl_sfx_id[id] against that slot's
               current value and refuse if it is lower ($80:B5A4), else
               claim the slot ($80:B5B1)
STX $1006      remember the id
STA $2141      id OR the toggle bit in $1002, then flip $1002 by $80
```

The toggle in bit 7 is what lets the same effect be retriggered: the
driver's port-1 handler at `$1137` only acts when the port **value
changes**, and `ASL A` throws the bit away before the table lookup. Writing
id 0 is "stop all effects" — `$1146` walks the voices, clears the track
pointers and keys off every voice flagged in `$22`.

The three parallel 126-byte tables, dumped to `build/spc/sfx_table.tsv`:

| table | address | what it actually does |
|---|---|---|
| `tbl_sfx_slots` | `$80:B7C9 (0x0037C9)` | bit mask of the 3 SNES-side slots this effect may occupy |
| `tbl_sfx_id` | `$80:B847 (0x003847)` | the value compared against a slot's occupant — this, not the next table, is the priority |
| `tbl_sfx_priority` | `$80:B8C5 (0x0038C5)` | stored to `$100E+slot` and, as far as a search of banks `$80`-`$87` shows, **never read** |

The slot mask lines up with the DSP voice: bit *k* set corresponds to the
effect's pattern using voice *5+k*, for 120 of the 125 effects (the
exceptions are `$08`, `$1C`, `$1D`, `$3F`, `$4E`). Nothing in the driver
enforces that, so treat it as a convention of the data, not a rule.

170 `JSL $80:B542` call sites exist across banks `$80`-`$87`. 160 are
preceded directly by an `LDA #$00xx` and so can be labelled by context;
`sfx_table.tsv` and `sfx/index.tsv` list them per id. The other ten
(`$81:C890`, `$83:920F`, `$83:BA1A`, `$83:D112`, `$84:88F4`, `$84:89CB`,
`$84:DA95`, `$85:9855`, `$85:AE88`, `$87:8572`) compute the id or read it
from a table.

### Playable .spc per effect

`nspc.py --spc` writes one file per effect, using the same port-table patch
as the song files with two changes:

* the **port-1** slot of the `$05F0` table holds the effect id, which the
  driver's `$1137` poll picks up on its first pass;
* the **port-0** slot still holds `$7E`, because SPC `$0A3A` returns from
  the whole tick routine when `$04` (the current song) is zero and the
  effect's voices would then never advance. A 20-byte silent song is
  planted at the song slot `$6502` — a one-word list naming a pattern whose
  eight track pointers are all zero — so the sequencer keeps ticking with
  nothing to play. `make_sfx_spc` asserts that `$6502` is empty in the base
  image first, so it can never overwrite real data.

This is a synthetic construction, not ROM data, and it is the only thing in
these files that the game itself never assembles.

## MIDI export

`nspc.py --midi` writes a type-1 Standard MIDI File per sequence, hand-built
with `struct` — one MIDI track per DSP voice, percussion on channel 10.
Tempo comes from the `$E7` command: the sequencer ticks at
500 Hz × tempo/256 (SPC timer 0 divided by `$10` at `$082F`), and the export
fixes 48 MIDI ticks to the quarter note.

It is lossy, and deliberately so. Vibrato, tremolo, pitch slides, fine
tuning, echo, the per-instrument pitch scaler and the gate curve's effect on
timbre are all dropped; instrument numbers become program changes, which is
a label rather than a sound. Loops are expanded once and the output is
capped at 64 patterns, so a `.mid` is shorter than the real song. The
`midi_notes` column in `summary.tsv` is the note count in the file, checked
by reading the file back, next to `notes`, the static count in the data.
Use the `.spc` files to hear the music; use the `.mid` to read it.
