# Audio: N-SPC driver, samples, and music

The game uses the N-SPC (Nintendo/HAL) sound driver. The strings
`nintenhalken` at `0x000ECC` and `*Ver S1.20*` at `0x0033C9` identify it,
and the second string also appears at SPC offset `0x112D` inside the
uploaded driver image, confirming the driver in ROM is that version.

`tools/spc_extract.py` extracts everything below. `tools/dis_spc700.py`
disassembles the driver, `tools/brr.py` decodes samples.

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

Every file requests id `$7E` whichever song it contains. That is correct:
the driver looks a song's sequence pointer up at SPC `$3AFE + 2*id`, and
the `$7E` slot holds `$6502` — the fixed address `sub_spc_upload_song`
loads every song to. Slot `$7F` holds `$3C00`, so requesting the song's own
id would play the wrong data.
