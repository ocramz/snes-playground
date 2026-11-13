## 65816 gotchas

These produce *silently wrong* results rather than errors, worst first.

- **M/X flag widths change instruction length.** `LDA #$12` is two bytes with
  `M=1`; `LDA #$1234` is three with `M=0`. You must track the flags through
  `REP`/`SEP` to decode at all — `REP #$30` sets A and X/Y to 16-bit, `SEP #$30`
  to 8-bit. The init code at `0x000000` does `REP #$30` early, so most of it is
  16-bit.
- **Flag state is not local to a routine.** A subroutine may be called with
  either width and may rely on its caller's. If the entry width is unknown, say
  so rather than guessing.
- **`JSL`/`RTL` vs `JSR`/`RTS`.** Long calls push a 3-byte return address, short
  calls 2. Mismatching them corrupts the stack. Record which convention a
  routine uses in its notes.
- **Bank crossing.** `JMP`/`JSR` stay in the current bank; only `JML`/`JSL`
  change it. Data addressing goes through the DBR and is bank-relative, and
  16-bit indexing wraps within a bank rather than carrying into the next.
- **Direct page moves.** `D` is not always `$0000`, so an operand that looks
  like `$12` may be `$0012` or `$2112`. Check for `TCD`/`PHD`.
- **Code and data are interleaved.** Linear disassembly *will* desync when it
  walks into a table. Follow control flow from known entry points, stop at
  unconditional `JMP`/`BRA`/`RTS`/`RTL`, and treat unreached bytes as unknown
  rather than assuming they are code.
- **Some calls take their operands inline.** Twelve helpers are copied to
  WRAM `$1018`-`$120D` at boot and called with a near `JSR` from any bank;
  each reads 0 to 9 bytes placed after the call and fixes up its own return
  address (`JSR $1030 / idx / frames` alone has 924 call sites). A `JSR` to
  an address below `$2000` in banks `$83`-`$87` is one of these, and the
  bytes after it are data. The table is `RAM_HELPERS` in `tools/objanim.py`.
- **A callee can read its caller's bank.** `sub_vram_queue $80:8696` takes
  the bank of its block from the `JSL` return address on the stack, so the
  same 16-bit argument means a different address from each bank.

For register maps (`$2100-$21FF`, `$4200-$43FF`) and opcode tables, use
standard references (fullsnes, the 65816 manual) rather than half-remembered
tables.