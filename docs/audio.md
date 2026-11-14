# Audio: N-SPC driver, samples, and music

The game uses the N-SPC (Nintendo/HAL) sound driver. The strings
`nintenhalken` at `0x000ECC` and `*Ver S1.20*` at `0x0033C9` identify it,
and the second string also appears at SPC offset `0x112D` inside the
uploaded driver image, confirming the driver in ROM is that version.

`tools/spc_extract.py` extracts everything below. `tools/nspc.py` parses
the sequences, `tools/dis_spc700.py` disassembles the driver, and
`tools/brr.py` decodes samples. `tools/render_audio.py` turns the songs and
effects into WAV files with `tools/spcrender`, an SPC700 + S-DSP model
written for this repository, and `tools/audio_check.py` is how that model
was checked; see [Rendering](#rendering).

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

Seven of the 25 samples do not loop (directory entries 1, 4, 9, 66, 68, 69
and 74), and the DSP never plays those to the end. A block whose header says
"end" without "loop" silences the voice on the first sample for which it is
the current block, and the decoder runs ahead of playback, so at pitch
`$1000` a sample of *n* blocks produces `16n - 26` output samples: the last
block and the final eight samples of the one before are never heard.
`samples.tsv` and the reference WAVs list the full decoded length, which is
what is in the ROM, not what sounds. Measured by `audio_check.py brr`; the
derivation is in `audible_samples()` there.

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
Two independent players do produce sound from these files: `tools/spcrender`
and the libgme inside VLC 3.0.14 (see [Rendering](#rendering)).

The ID666 tag carries each file's own play length and fade, not a blanket
180 s. `spc_extract.py` and `nspc.py` write the figure the tempo formula
gives, which is a lower bound (see [Timing](#timing)); `render_audio.py`
then plays every file, measures the real length, and rewrites the tag:

| kind | length | fade |
|---|---|---|
| looping song | the intro and two passes of the loop, rounded up to a whole second (the tag holds whole seconds) | 10 s |
| song that ends | until the driver has dropped the song and the output is silent, rounded up | none |
| effect | until the driver has released the effect's voices and the output is silent, rounded up | none |

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

The repeat count is not simply "how many times":

```
0A4B  DEC $42
0A4D  BPL $0A51        ; still counting down
0A4F  MOV $42,A        ; went negative: (re)load the count
0A51  CALL $09B9       ; read the jump target
0A54  MOV X,$42
0A56  BEQ $0A43        ; reached zero: carry on with the next word
0A58  MOVW $40,YA      ; otherwise jump
```

`$42` is zero when a song starts (`$0A0F`), so the first visit decrements it
to `$FF` and loads the count. A count of `$01`-`$7F` then jumps that many
times. A count of `$81` or more decrements to a value that is still
negative, so it is reloaded on every visit and the jump is taken forever.
All 27 looping songs use `$C8`. It reads as "repeat 200 times" and the
listings in `songs/*.txt` print it that way, but it never runs out: song 0,
whose loop is one second long, was played for 400 s and jumped 401 times
with `$42` alternating `$C7`/`$C8`. The six songs that end (2, 3, 15, 17,
18, 31) have no repeat word at all. `nspc.pattern_order()` implements this
walk.

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
| `$0866` | `$80:AB03 (0x002B03)` | main loop: wait for timer 0, then the two accumulators below |
| `$0884` | `$80:AB21 (0x002B21)` | tempo gate: `$51 += low byte of ($53 * timer ticks)`, carry runs `$0A22` |
| `$08B2` | `$80:AB4F (0x002B4F)` | APU port mirror; `$08B6` is the six bytes `make_spc` patches |
| `$08BF` | `$80:AB5C (0x002B5C)` | note/tie/rest/percussion handler |
| `$09B9` | `$80:AC56 (0x002C56)` | read the next word of a word list |
| `$09CC` | `$80:AC69 (0x002C69)` | start the sequence named by port 0 |
| `$0A19` | `$80:ACB6 (0x002CB6)` | end of the voice reset on song start: master volume `$59` = `$C0`, tempo `$53` = `$20` |
| `$0A22` | `$80:ACBF (0x002CBF)` | sequencer tick: port 0, song advance, per-voice events |
| `$0A4B` | `$80:ACE8 (0x002CE8)` | repeat word: count in `$42`, see above |
| `$0AA6` | `$80:AD43 (0x002D43)` | per-voice event loop; its `MOV $5E,X` at `$0AA8` runs once per tick |
| `$0B9F` | `$80:AE3C (0x002E3C)` | write a voice volume to the DSP; scales by port 2 (`$02`) unless the voice belongs to an effect |
| `$0BAF` | `$80:AE4C (0x002E4C)` | command dispatch |
| `$0BC1` | `$80:AE5E (0x002E5E)` | fetch one track byte |
| `$0BCB` | `$80:AE68 (0x002E68)` | set instrument (also the percussion path) |
| `$0E1E` | `$80:B0BB (0x0030BB)` | command handler jump table, 27 entries |
| `$0E54` | `$80:B0F1 (0x0030F1)` | command argument counts, 27 entries |
| `$0F34` | `$80:B1D1 (0x0031D1)` | key-off look-ahead; the second reader of `$0E54` |
| `$10B7` | `$80:B354 (0x003354)` | voice volume: master `$59` x velocity x track volume, then squared |
| `$10DE` | `$80:B37B (0x00337B)` | echo FIR coefficient presets, 8 bytes each |
| `$1112` | `$80:B3AF (0x0033AF)` | semitone pitch table, 13 entries, octave 5 |
| `$1137` | `$80:B3D4 (0x0033D4)` | port 1 poll: start or stop a sound effect |
| `$1168` | `$80:B405 (0x003405)` | start a sequence from an id |

## Timing

How long anything lasts comes down to the driver's main loop at SPC `$0866`:

```
0866  MOV Y,$FD        ; timer 0 ticks since the last pass (500 Hz, $082F)
0868  BEQ $0866        ; none yet: wait
086A  PUSH Y
086B  MOV A,#$20
086D  MUL YA
086E  CLRC
086F  ADC A,$43
0871  MOV $43,A
0873  BCC $0884
0875  CALL $1137       ; every 256/$20 = 8 timer ticks: poll port 1 (effects)
...
0884  MOV A,$53        ; tempo
0886  POP Y
0887  MUL YA
0888  CLRC
0889  ADC A,$51
088B  MOV $51,A
088D  BCC $0899
088F  CALL $0A22       ; on carry: one sequencer tick
```

Tempo is a rate, not a divider: each timer tick adds the tempo to an 8-bit
accumulator and a carry is one sequencer tick, so the tick rate is
500 Hz x tempo/256. At `$25` that is 72.3 ticks a second, 13.84 ms each.
Starting any song resets the tempo to `$20` (`$0A1C`) and the song's first
`$E7` replaces it; no song in this ROM uses the tempo fade (`$E8`).
`nspc.sequence_timeline()` lays a sequence out in ticks and converts with
this formula.

**The formula is a lower bound.** `MUL YA` leaves the product's high byte in
`Y` and only `A` is added, so the accumulator gains just the *low byte* of
tempo x elapsed ticks. As long as that product stays below 256 it is the
whole product. But a pass that takes 7 timer ticks (14 ms) or more at tempo
`$25` (7 x 37 = 259) overflows the byte, and a whole sequencer tick's worth
of time is thrown away. The song does not skip anything; it just runs late
by 13.84 ms each time. Passes that long are common: the pass that runs a
tick processes every voice's events before returning, and the renderer
measured key-ons landing a median 7 ms and up to 21.8 ms after their tick
began.

How much this costs depends on how busy the arrangement is. Measured by
playing every file (`wav/index.tsv`, columns `ideal_s`, `actual_s`,
`late_ms`):

| | formula | measured | late |
|---|---|---|---|
| song 6, one loop | 43.838 s | 43.838 s | 0 ms |
| song 11, one loop | 63.765 s | 63.846 s | 81 ms |
| song 19, one loop | 255.059 s | 255.294 s | 235 ms |
| song 31, start to end | 14.965 s | 19.103 s | 4138 ms |
| effect `$12`, start to end | 13.401 s | 13.472 s | 71 ms |
| all 33 songs, median | | | 15 ms |

Song 31, an eight-voice piece that ends, takes 28% longer than its notes
say. 23 of the 33 songs lose a tick on their very first pass, where every
voice is set up at once: the first tick is at 0.116-0.117 s in every file,
and in those 23 the second comes two tick lengths later instead of one.

This is the driver's arithmetic, so the same thing should happen on a
console, but that is **unconfirmed**: there is no hardware capture to
compare with. What is established is that two independent SPC700 models
agree on it. VLC's libgme, played against `spcrender` over the first 60 s
of songs 2, 6, 22 and 30 and the 17.6 s of song 31 that libgme plays, stays
within 3 samples of it from start to end (see [Rendering](#rendering)). Whether a borderline pass
drops a tick depends on where the timer happens to be, to the cycle, so an
exact count is sensitive to details no static rip can pin down: an earlier
build of the renderer that read the timer two cycles early (at the start of
`MOV Y,$FD` rather than on its last cycle) ended one tick, 449 samples,
apart from libgme after 60 s of song 22.

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

Effects use DSP voices 5-7 only, all 125 of them. The music does not keep
to 0-4: 17 of the 33 songs have a track on voice 5, 6 or 7 in at least one
pattern (songs 2, 4, 5, 15, 17-23, 25, 26, 28, 30-32; four of those, 2, 15,
18 and 31, use all eight), and 16 of them actually key a note there within
the intro and two loops; song 28's voice-5 track never does. Of the other
16, song 1 has tracks on voices 0 and 1 and the remaining 15 on voices 0-4
(among them song 0, which keys nothing, and song 3, which keys notes on only
two of its five). Measured from the pattern tables (`songs/summary.tsv`)
and from the key-ons the renderer logged (`wav/index.tsv`).

So a song and an effect can want the same voice. The effect wins: `$1168`
overwrites the voice's track pointer with the effect's, and when the effect
ends `$0AC6` zeroes that pointer rather than giving it back. The song's
part on that voice therefore stays silent until the next pattern is loaded
(`$0A63` reloads only voices not flagged in `$22`). Read from the code, not
observed in a render: no file here plays an effect over a song that uses
voices 5-7.

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
  driver's `$1137` poll picks up on its second pass, about 35 ms in;
* the **port-0** slot still holds `$7E`, because SPC `$0A3A` returns from
  the whole tick routine when `$04` (the current song) is zero and the
  effect's voices would then never advance. Something has to be playing.

What is playing matters, because an effect has no tempo or level of its
own. Its tracks are advanced by the same tick as the song's (`$0A22`, gated
at `$0884` by the song's tempo `$53`), and every voice's volume, effect
voices included, is scaled by the song's master volume `$59` at `$10B7`.
None of the 125 effects contains a tempo (`$E7`), master volume (`$E5`) or
echo command, so both are whatever the song left.

The files use **song 0** as that song, because the game does. Its SOUND
ROOM handler (`$83:B9A5`-`$83:BAAE`):

```
$83:B9BB  LDA #$007E / JSL $80:B4AC     on entry: upload and start song 0
$83:BA0C  LDA $EA86 / BNE $BA20         which row the cursor is on
$83:BA11  LDA #$007E / JSL $80:B4AC     FGM row: song 0 again...
$83:BA18  LDA $B0   / JSL $80:B542      ...then trigger effect number $B0
$83:BA20  LDA $B2 / CLC / ADC #$007E    BGM row: song number $B2
$83:BA26  JSL $80:B4AC
```

`sub_spc_play_song` skips the upload when the requested id is already in
`$1004`, so after a BGM the FGM path re-uploads song 0 and otherwise it
leaves it running. The limits table at `$83:BAAF` holds `$007E` and `$0021`
(compared at `$83:BA6A`): 126 FGM numbers (0 is "stop effects") and 33 BGM
numbers. The screen's two labels are the strings `FGM:000` at `$83:BDBD`
and `BGM:000` at `$83:BDC6`, in that order ([text.md](text.md)), which is
what ties cursor row 0 to effects and row 1 to songs. So the SOUND ROOM's
numbering is the data's own: **BGM n is song n, FGM n is effect id n.**

Song 0 (77 bytes, `$97:D413`) is a carrier and nothing else: five voices
set to volume 0 that rest for 72 ticks, in a loop that never ends. Its first
tick does three things that reach the effect: `$E7 $25` sets the tempo,
`$E5 $FF` the master volume, and `$F5 $1F $00 $00` an echo mask that covers
voices 0-4 only, at volume 0. An effect file is therefore the ROM's own
bytes throughout, and the only things in it the game never assembles are
the six patched bytes at `$08B6` and the port table they read.

Earlier versions of these files planted a 20-byte synthetic song instead
(one pattern, all eight track pointers zero). It kept the sequencer ticking
but set nothing, which left the values the driver resets to on every song
start (`$0A19`: master volume `$C0`; `$0A1C`: tempo `$20`). Effects came out
slower and quieter than the SOUND ROOM plays them:

| | tempo | tick | master volume |
|---|---|---|---|
| song 0 | `$25` | 13.84 ms | `$FF` |
| synthetic silent song | `$20` | 16.00 ms | `$C0` |

That is 37/32 = 1.156 times as long, and the squared volume chain makes it
(192/255)^2 = 0.57 times as loud. Rendering seven effects both ways gave
duration ratios of 1.131-1.156 and peak ratios of 1.63-1.89 around the
expected 1.76. Three of them (`$08`, `$0B`, `$73`) were also counted tick
by tick: the number of ticks is the same under either carrier, and the
durations miss 1.156 only because ticks land on the 2 ms timer grid and
song 0 sometimes drops one (see [Timing](#timing)). The old behaviour is
still there as `nspc.py --sfx-carrier silent`.

One caveat on "the" speed and level of an effect: during play it runs at the
tempo and master volume of whichever song is on, and 12 of the 33 songs do
not use tempo `$25` (the range is `$1D`-`$2B`). The files reproduce the
SOUND ROOM, not every context.

## Which code plays what

Nothing in the ROM names a song, so the nearest thing to a name is who asks
for it. `nspc.py` writes `build/spc/song_callsites.tsv` with every call into
the three song entry points, which share one body and take the id in a
16-bit `A`:

| routine | what it does | call sites |
|---|---|---|
| `sub_spc_play_song $80:B4AC` | upload the song if it is not the one in `$1004`, then write `$7E` to port 0 | 35 |
| `$80:B4F1` (`sub_spc_command` in `symbols.tsv`) | write `$7E` to port 0 without uploading | 2 |
| `$80:B521` | upload without starting | 2 |

The last two are used as a pair, upload now and start later, for songs 16
(`$83:D9FF`, `$83:DA11`) and 32 (`$83:D90F`, `$83:D921`).

A request's byte is `$7E` + the song number (above), so `$89` is song 11.
The engine's song events carry the number, not the byte. A song request
also blocks the main loop on the APU's port handshake (`$80:B70A`-`$80:B724`)
for about 3 frames. On the fall's request both fly traces skip from record
3252 to 3256 (the engine's `apuLag` stall; [emulation.md](emulation.md)
"Frames, iterations and snapshots"). Other requests probably lag the same
way, but only the fall's is measured.

Every song and effect request of a 1-player hole was matched to the game's own sound log on seven recorded runs, about 230 requests in all (the engine's `events.test.ts`). The list of who requests what in play, with the sites, is the event table of [engine.md](engine.md). Three of the requests are easy to miss:
* the meter's latch requests effect 0 (stop all effects) twice (`$81:C038`, `$81:C046`);
* a fly shot's first bounce plays `$68F0` + 4, set from the spin at the launch (`$84:89D0`, `$81:9BF4`; [physics.md](physics.md) "The two steps, in full");
* the hole-out stops the music by setting its volume to 0 when the ball has sunk (`$80:B5F4`), not by a request.

Of the 35 `JSL $80:B4AC`, 33 load a constant id with `LDA #$00xx` directly
before the call: three pass 0 (stop the music) and 30 name a song. The other
two compute it: `$83:BA26` is the SOUND ROOM's BGM row, and `$87:8580` is
one opcode of a script interpreter that takes the id from the next byte of
its stream (`LDA [$D0] / INC $D0 / AND #$00FF`); the opcode beside it at
`$87:856B` does the same for effects.

That gives 21 songs at least one fixed caller. Of the other 12 (songs 3,
6-14, 18 and 27), eleven have a caller the scan cannot label (found
2026-11-14):

* **The hole songs.** `$80:C967` (JSL, ending in `JML $80:B4AC`) chooses
  the song:
  * song 27 (`$99`) when `$ED5B` is set;
  * stop (`$7E`) when `$00C2` or `$ED07` is set;
  * otherwise a byte of a per-course list, `$80:C99D`[`$6A5C`] →
    [`$6A5E`, the hole]. The pointer table holds 28 words and the lists 8
    bytes each.

  Course 1 is entry 0: songs 11, 11, 11, 11, 7, 7, 7, 13. Every list but
  the all-27 one ends with 13 (`$8B`), and the lists use exactly songs 6-14
  and 27. Which `$6A5C` each other course or mode has is not measured.

  *Emulated* on the course-1 autoplay replay (`--log-pc '$80:C999'`):
  * `$89` (song 11) at the start of holes 1-4, `$85` (7) at holes 5-7 and
    `$8B` (13) at hole 8;
  * each twice: from the hole's start (`$80:C499`) and 13 frames later
    (`$82:B0E8`).

  The same routine restarts the song after a lost ball (`$82:B0E8`) and when
  Kirby wakes after running out of tomatoes (`$82:E25B`;
  [flow.md](flow.md)). So the "script data" guess was wrong for these ten.
* **The fall.** `$81:A175` loads `$90` (song 18) and replaces it with `$8F`
  (17) in ball mode 10, three instructions before its `JSL $80:B4AC` at
  `$81:A183`. The scan saw only the second constant. *Emulated*: web_fly
  requests `$90` at 3252 (caller `$81:A187`).

So only song 3 has no known caller. The
`used_by` column of `songs/summary.tsv` and of `wav/index.tsv` carries the
call sites per song, and `sfx/index.tsv` does the same for effects. No
names beyond that are offered: tying a call site to a screen is work for
[scenes.md](scenes.md), not something the audio data can settle.

The one fixed numbering is the SOUND ROOM's, derived in
[Playable .spc per effect](#playable-spc-per-effect): BGM *n* is song *n*
(`song_NN`), FGM *n* is effect id *n* (`sfx_XX`, in hex).

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
Use the WAVs from `render_audio.py` (or the `.spc` files) to hear the music;
use the `.mid` to read it.

## Rendering

`python3 tools/render_audio.py` writes every song and effect as a 32 kHz
stereo 16-bit WAV under `build/spc/wav/` and an `index.tsv` beside them.

### The renderer

`tools/spcrender` is a Rust crate with no dependencies. It reads a standard
`.spc` (v0.30: CPU registers in the header, 64 KB of RAM at `0x100`, the 128
DSP registers at `0x10100`, the 64 bytes of RAM under the boot ROM at
`0x101C0`), runs whatever program is in it, and writes PCM. It knows nothing
about N-SPC.

| file | what |
|---|---|
| `src/cpu.rs` | the SPC700: all 256 opcodes in one `match` with no wildcard arm, so the compiler proves the decode is total and has no overlaps |
| `src/apu.rs` | RAM, the I/O page `$F0`-`$FF`, the three timers (8 kHz, 8 kHz, 64 kHz), the boot ROM overlay on `$F1` bit 7, `.spc` loading |
| `src/dsp.rs` | the S-DSP: BRR decoding (four filters, loop and end flags), 4-point Gaussian interpolation, pitch and pitch modulation, ADSR and the GAIN modes, noise, KON/KOFF/ENDX/FLG, voice and master volume, echo with the 8-tap FIR, ENVX/OUTX read-back |
| `src/tables.rs` | the Gaussian kernel, boot ROM, rate periods and offsets, cycle counts |
| `src/main.rs` | options, the render loop, the WAV and log writers |
| `src/selftest.rs` | 39 checks with hand-derived answers, run by `--selftest` and `cargo test` |

The APU ports `$F4`-`$F7` are static latches holding the image's values. The
driver in these files never reads them (that is what the `$08B6` patch is
for), but a read still returns something sane.

Where the tables came from, since half-remembered ones were the obvious way
to get this wrong: the Gaussian kernel, the boot ROM, the rate periods and
the per-opcode cycle counts were parsed by script out of the fullsnes text
(<https://problemkaputt.de/fullsnes.htm>). The kernel is byte-identical to
the copy inside VLC's `libgme_plugin.dylib` (stored interleaved, at file
offset 218752) and the cycle counts agree with libgme's packed table (offset
217624) on all 254 opcodes that have one; SLEEP and STOP have none and halt
the CPU here. The rate offsets are from
<https://snes.nesdev.org/wiki/DSP_envelopes>, which cites Anomie's S-DSP
document. `DIV YA,X` is fullsnes' 9-step divider, and the self-test compares
it with the closed form other emulators use on all 2^24 inputs.

Build and run by hand:

```
CARGO_TARGET_DIR=build/spcrender cargo build --release --offline \
    --manifest-path tools/spcrender/Cargo.toml
build/spcrender/release/spcrender IN.spc -o OUT.wav
```

With no length options it plays the file's ID666 length and fade. The
others: `--seconds N`, `--fade MS`, `--until-silent [TAIL_MS]` (stop once
every envelope is 0, no key-on is pending and the output has been exactly
zero for the tail), `--busy ADDR` (do not stop while this RAM byte is
non-zero), `--min-seconds N`, `--trim-leading`, `--stems` (one WAV per
voice), `--log-kon FILE` (every key-on: sample, time, voice, SRCN, pitch,
BRR address, ADSR, GAIN, volumes), `--mute-voices MASK`, `--watch ADDRS`
with `--log-watch FILE` (every CPU write to those RAM addresses, with the
PC that made it), `--trace N`, `--selftest`. A one-line JSON summary goes to
stdout.

`--watch` is what makes the measurements in this document possible without
teaching the renderer about the driver: the loop point is a write to `$40`
from `$0A58`, a sequencer tick is the write to `$5E` from `$0AA8`, a song
has ended when `$04` is zero and an effect when `$22` is.

### Validation

Nobody has listened to any of this, so the renderer was checked against
three things that are not the renderer. `python3 tools/audio_check.py`
reruns all of it and writes `build/spc/check/{brr,kon,vlc}.tsv`.

**1. BRR, against `tools/brr.py`.** A test program keys one voice on at
pitch `$1000` with a direct GAIN of `$7F`, VxVOL and MVOL `$7F`, for each of
the 25 distinct samples. The expected output is computed in Python from
`decode_brr()` and the documented fixed-point chain. All 94,006 output
samples compared are **bit-identical**, 0 mismatches, on both channels.

What had to be allowed for, exactly:

* *Offset.* The first audible output sample is index 12 in every case. The
  program's 28 register writes take 140 cycles, so KON is written during
  sample 4; the DSP polls KON every other sample (latched after sample 5,
  acted on in sample 6), then spends 5 samples starting the voice (7-11).
  That is 8 samples from the write, the same figure the self-test pins.
* *Shape.* Output *k* is not sample *k*. At pitch `$1000` the interpolation
  phase is always 0, where the 4-point kernel is the three taps
  `$172, $519, $176` (370, 1305, 374, over 2048) on samples *k*, *k*+1,
  *k*+2, and the fourth tap is zero. So the output is the decoded sample
  smoothed and one sample late. Against the raw `decode_brr()` output
  shifted by that one sample the correlation is 0.912-0.999999; the low end
  is the brightest sample, where smoothing changes most.
* *Scale.* 2 (15-bit samples, 16-bit output) x 2049/2048 (the taps) x
  `$7F0/$800` (the envelope) x (127/128)^2 (the two volumes) = 1.9544 at DC.
* *Tail.* The seven non-looping samples go silent `16n - 26` output samples
  in, as described under [Samples](#samples), and stay at exactly zero.

**2. Sequencing, against `tools/nspc.py`.** For all 33 songs (each played
for 1.3 times its formula length, so past two loops) and all 125 effects,
every key-on the DSP acted on was assigned to a sequencer tick using the
driver's own tick marker, and compared with the note-ons
`sequence_timeline()` lays out from the data:

| | note-ons laid out | matched on voice and tick | missing | extra |
|---|---|---|---|---|
| 33 songs | 89,940 | 89,940 | 0 | 0 |
| 125 effects | 1,591 | 1,591 | 0 | 0 |

So the renderer runs the driver the way `nspc.py` reads the data, pattern
order and loops included. A key-on lands a median 7.1 ms after its tick
begins in songs (11.0 ms in effects) and at most 21.8 ms.

Timed against the tempo formula instead of the measured ticks, the same
note-ons start 0.119 s into the file in the songs that lose nothing and
then fall behind as described under [Timing](#timing): per song the median
error is 13 ms once that song's own offset is removed, but the last tick
compared is late by anything from nothing to 4.14 s (song 31), with songs
19 and 30 at 0.64 s and 0.58 s.
Effects end between 2 ms early and 70 ms late. The formula is right about
which tick; it is not a clock.

**3. An independent decoder: libgme in VLC 3.0.14.** VLC transcodes a
`.spc` headlessly:

```
/Applications/VLC.app/Contents/MacOS/VLC -I dummy --no-video --play-and-exit \
    --stop-time=60 IN.spc \
    --sout '#transcode{acodec=s16l,channels=2,samplerate=32000}:std{access=file,mux=wav,dst=OUT.wav}' \
    vlc://quit
```

`--stop-time` is not optional. VLC's gme demuxer ignores the ID666 length,
and the first attempt without it wrote 1.4 GB (3 h 06 min of audio) before
stopping. `audio_check.py` also kills VLC if the file passes a size guard.

libgme skips leading silence and post-filters its output, so the two are
aligned by cross-correlation and compared for similarity, over 60 s (17.6 s
for song 31, which is all libgme plays of it):

| file | lag | drift over the clip | RMS envelope, 50 ms windows | waveform | spectrogram cosine | coherence, 125 Hz-1 kHz |
|---|---|---|---|---|---|---|
| 500 Hz square wave | -15 | 0 | 1.00000 | 0.9994 | 0.9997 | 0.997-1.000 |
| song 6 | +4081 | -1 | 0.99994 | 0.9952 | 0.9994 | 0.988-1.000 |
| song 22 | +4081 | 0 | 0.99997 | 0.9962 | 0.9996 | 0.988-1.000 |
| song 2 | +4081 | 0 | 0.99997 | 0.9983 | 0.9998 | 0.995-1.000 |
| song 30 | +3398 | 0 | 0.99947 | 0.9907 | 0.9984 | 0.979-0.999 |
| song 31 | +4081 | +3 | 0.99983 | 0.9913 | 0.9971 | 0.932-0.993 |

Lag and drift are in samples; the lag is the silence libgme skipped. Drift
is the lag measured again on the last 4 s after aligning the start, so it
is the tempo comparison: over a minute the two decoders stay within 3
samples, including through the passages where songs 30 and 31 drop ticks.

Two things differ, and both are on libgme's side of the comparison as far
as can be told. Its level is 1.30 times `spcrender`'s, flat from 125 Hz to
500 Hz on both the songs and the test tone, falling on the songs to
0.99-1.05 at 4 kHz and 0.62-0.84 at 8 kHz: an output gain and a gentle
low-pass. The songs' third-octave levels agree within 1.2 dB from 200 Hz to
4 kHz once the overall gain is removed and differ by up to 6.6 dB at
11 kHz. Coherence falls with frequency in step (0.84-0.87 at 4 kHz for
songs 2, 6, 22 and 30, 0.75 for song 31). Why libgme applies that gain was not investigated; `spcrender`'s
absolute level rests on check 1 and on the self-test's hand-computed case
(a constant sample of `7 << 11` at full volume must settle at exactly
28016), not on this comparison.

### Known deviations

* **Not compared with hardware.** Everything above is agreement with
  documentation, with the repository's own decoders and with one other
  emulator. A console capture would be the real test.
* **Where the DSP's internals came from.** The tables were fetched (see
  above). The order of operations inside one sample was not: the five-sample
  key-on schedule, the point at which an end block mutes a voice, and which
  sums wrap and which saturate were written from memory of how blargg's
  snes_spc does them, then checked against fullsnes wherever fullsnes
  states the rule. The `16n - 26` tail figure follows from that schedule.
  libgme is the same author's code, so agreeing with it does not confirm
  those points independently. The same goes for `DAA`/`DAS`, which follow
  the usual emulator rule and which this driver never executes.
* **Instruction-stepped, not cycle-stepped.** The CPU runs whole
  instructions and the DSP runs once per 32 cycles, so a DSP register write
  lands up to one instruction (12 cycles) from where the hardware would put
  it. Timer outputs are the exception: they are read on the instruction's
  last cycle, because the driver turns that count into tempo.
* **Timer phase.** Where the timers stand when a song starts depends, on a
  console, on when the S-CPU wrote the port. Here it is whatever a cold
  start of the image gives. Since a borderline pass drops a tick or not
  depending on that phase, real hardware need not lose exactly the same
  ticks. **Unconfirmed** either way.
* **Polarity and analogue stage.** The console's post-amplifier inverts the
  signal (fullsnes, "Output Mixer") and low-pass filters it. Neither is
  modelled; the output is the DSP's digital output, as other SPC players
  give it.
* **Sub-sample register timing.** ENVX, OUTX and ENDX are updated once per
  sample; the hardware's windows in which a write to them or to KON/KOFF is
  lost are not modelled. The `TEST` register (`$F0`) is ignored.
* **Opcode coverage.** The driver executes 106 of the 256 opcodes across all
  158 renders. The other 150 are covered by reading them against fullsnes
  and by the self-test's spot checks only; nothing here exercises them at
  length.

### What the batch produces

From the run recorded in `build/spc/wav/index.tsv`:

* 33 song WAVs and 125 effect WAVs, 42.7 minutes in all (40.3 of songs,
  2.4 of effects), 313 MB.
* One file is silent, and should be: song 0, the carrier, keys no notes.
* Song lengths run from 2.8 s (song 3: two notes, though the sequence
  idles until 6.4 s) to 537 s (song 19, whose loop is 255 s long).
* Effects last 0.26 s to 13.3 s, median 0.76 s, each including the 0.25 s
  of silence that ends it. Their WAVs start at the first non-zero sample;
  the 0.13-0.22 s the driver takes to start is trimmed and recorded as
  `lead_in_s`.
* `loop_start_s` and `loop_length_s` are measured from the driver's own
  loop jump and are in file time, so a loop starts at `loop_start_s` in the
  WAV and the fade begins at the tag length.
* About 150 times real time for one render; the whole batch takes 15 s on
  eight cores.
