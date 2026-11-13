# Animation scripts

Objects are not animated by hardcoded update routines. Each one runs a
bytecode thread: a little interpreter walks a script in ROM, and the script
tells the object which metasprite frame to show, for how long, and where to
move. This is the layer between the object system and the metasprite data
described in [graphics.md](graphics.md).

Everything below is read off the disassembly of `$80:9564-$80:9C94` and the
two dispatch tables, unless it is marked otherwise. Ground truth is the four
object-type scripts at `$87:99FE (0x0399FE)`, which are the only scripts
anything in the ROM points at.

```bash
python3 tools/anim.py --opcodes --notes     # the opcode table, sizes, handlers
python3 tools/anim.py --types --frames      # the four ground-truth scripts
python3 tools/anim.py --verify              # assert their lengths and operands
python3 tools/anim.py --script '$87:99FE'
python3 tools/anim.py --scan                # -> build/sprites/scripts.tsv
```

## The interpreter

`sub_anim_script_run $80:9564 (0x001564)`, 82 bytes, `JSR`/`RTS`. One call
runs one thread, for one game tick. On entry `$DA` is the thread index times
two and `$D0` is `$0000` (set by `sub_obj_tick_all $80:94C7`), so `[$D0],Y`
with the bank in `$D2` is a long pointer to the script.

```
LDX $DA                       ; thread slot
LDA $0CBE,X / BNE $95B2       ; wait timer nonzero -> DEC it and return
LDY $0CFE,X                   ; Y = script PC
LDA $0D3E,X / STA $D2         ; script bank -> the long pointer's bank byte
TXA / ASL x3 / ADC #$0DBE     ; $D4 = $0DBE + 8*thread, the thread's locals
fetch:  LDA [$D0],Y / INY
        CMP #$0070 / BCS packed
        ASL A / TAX / JSR ($95B6,X)
        BRA next
packed: AND #$000F / STA $0CBE,X          ; wait ticks = low nibble
        LDA / AND #$0070 / LSR x3 / TAX
        JSR ($9630,X)
next:   LDA $0CBE,X / BEQ fetch           ; still no wait -> run the next one
        TYA / STA $0CFE,X                 ; save PC
        LDA $D2 / STA $0D3E,X             ; save bank
        DEC $0CBE,X
        RTS
```

Two consequences worth spelling out:

* **Only a packed opcode can end a tick.** Everything below `$70` runs and
  falls straight back into `fetch`, so a script executes an unbounded run of
  plain opcodes in a single frame until it hits a wait or halts.
* **A wait of `n` means the next opcode runs `n` ticks later.** The timer is
  set to `n` and then immediately decremented on the way out, so `wait=0`
  does not stop at all.

## Opcode encoding

| range | meaning |
|---|---|
| `$00-$3C` | plain opcode, dispatched through `tbl_anim_opcodes $80:95B6` |
| `$3D-$6F` | **out of range.** The table has 61 entries and ends at `$9630`; these index into `tbl_anim_wait_actions` instead. Nothing emits them; `tools/anim.py` calls them `?invalid` |
| `$70-$FF` | packed: wait ticks = bits 0-3, action = bits 4-6, dispatched through `tbl_anim_wait_actions $80:9630` |

The packed form is why the common case costs one byte: `$8N` is "show frame
*x*, wait *N* ticks" with a single operand byte.

### The packed wait-actions

Bit 7 of the opcode is ignored by the `AND #$0070`, so `$7N` and `$FN` are the
same action.

| opcode | action | operand | handler | effect |
|---|---|---|---|---|
| `$8N` | 0 | 1 byte | `$80:971D` | frame index `$0B7E,X` = byte; `$FF` stores `$FFFF`, which `sub_obj_draw` reads as invisible |
| `$9N` | 1 | 0 | `$80:9A92` | `INC` the frame index |
| `$AN` | 2 | 0 | `$80:9A98` | `DEC` the frame index |
| `$BN` | 3 | 1 byte | `$80:9A9E` | frame index += signed byte |
| `$CN` | 4 | 2 bytes | `$80:9785` | X velocity = signed 8.8 (`$0A3E,X` frac, `$09DE,X` whole) |
| `$DN` | 5 | 2 bytes | `$80:97A3` | Y velocity = signed 8.8 (`$0A5E,X` / `$09FE,X`) |
| `$EN` | 6 | 2 bytes | `$80:97C1` | Z velocity = signed 8.8 (`$0A7E,X` / `$0A1E,X`) |
| `$7N`, `$FN` | 7 | 3 bytes | `$80:999A` | far call `addr16,bank8` via `JSL $80:9D98` = `JML [$0876]`, with the thread register in `A`; the returned `A` is stored back into the register |

### The plain opcodes

Operand sizes were counted off each handler: `LDA [$D0],Y` is a 16-bit fetch
and the `INY`s after it say how many bytes it actually consumed, so one `INY`
after a fetch means the high byte was thrown away and the operand is a single
byte. `field` selects one of four per-object words through the table at
`$80:9B4C` (`$0A9E`, `$0ABE`, `$0ADE`, `$0AFE`, plus object index * 2).
`<op>` selects one of four read-modify-write routines from `$80:9B10`:
0 `AND`, 1 `ORA`, 2 `ADC`, 3 `EOR`.

| op | bytes | name | effect |
|---|---|---|---|
| `$00` | 0 | `obj_destroy` | `JSR $9C79`, the object destructor, then wait = `$FFFF` |
| `$01` | 1 | `loop` | push PC and a 1-byte count as a 3-byte local-stack frame |
| `$02` | 0 | `loop_end` | decrement the pushed count; branch back to the pushed PC, or pop the frame and fall through |
| `$03` | 3 | `jml addr,bank` | far jump; sets `Y` and the script bank `$D2` |
| `$04` | 3 | `jsl addr,bank` | far call; pushes PC + bank as a 3-byte frame |
| `$05` | 0 | `rtl` | far return; when the local stack is empty, falls into `end_thread` |
| `$06` | 1 | `wait` | set the wait timer directly, 0-255 ticks |
| `$07` | 2 | `spawn addr` | allocate a thread (`$9D09`) starting at `addr` in the same bank, linked through `$0C3E,X` |
| `$08` | 3 | `set_obj_hook addr,bank` | `$0B3E,X`/`$0B5E,X`, the long vector `$80:9510` calls each tick; `$9D9B` resets it to `$80:94C6` |
| `$09` | 0 | `halt` | `DEY` back onto this byte, wait = `$FFFF`. **The terminator** |
| `$0A` | 2 | `beq_reg addr` | branch when the thread register `$0D7E,X` is zero |
| `$0B` | 2 | `bne_reg addr` | branch when it is nonzero |
| `$0C` | 0 | `end_thread` | unlink the thread (`$9D18`); also destroys the object when `$08BE,X` is negative |
| `$0D` | 5 | `rmw_abs addr,op,imm16` | word at `addr` `<op>=` `imm16` |
| `$0E` | 3 | `set_field n,imm16` | object field[n] = `imm16` |
| `$0F` | 0 | `reset_obj_hook` | `JSR $9D9B`, hook back to `$80:94C6` |
| `$10` | 1+2n | `switch n,targets` | jump via the thread register into `n` word targets; register >= `n` falls through past the table |
| `$11` | 1+2n | `switch_call n,targets` | as `switch`, but pushes the address after the table as a 2-byte frame first (matched by `$1B`) |
| `$12` | 3 | `store_byte addr,imm8` | byte at `addr` = `imm8` |
| `$13` | 0 | `end_linked_thread` | `end_thread` applied to the thread linked at `$0C3E,X` |
| `$14` | 4 | `rmw_field n,op,imm16` | object field[n] `<op>=` `imm16` |
| `$15` | 4 | `store_word addr,imm16` | word at `addr` = `imm16` |
| `$16` | 2 | `beq_reg_unwind addr` | register zero: drop a 3-byte local frame **and** jump; otherwise skip the operand |
| `$17` | 2 | `bne_reg_unwind addr` | the complement |
| `$18` | 4 | `rmw_abs8 addr,op,imm8` | the 8-bit `rmw_abs`; the `$9B10` handler is called under `SEP #$20` |
| `$19` | 2 | `jmp addr` | near jump, same bank |
| `$1A` | 2 | `jsr addr` | near call; pushes a 2-byte frame |
| `$1B` | 0 | `rts` | near return; empty stack falls into `end_thread` |
| `$1C` | 3 | `set_frame_table addr,bank` | **bind a frame pointer table**; see below |
| `$1D` | 2 | `set_reg imm16` | thread register `$0D7E,X` = `imm16` |
| `$1E` | 2 | `load_reg_abs addr` | register = word at `addr` |
| `$1F` | 1 | `store_reg_field n` | object field[n] = register |
| `$20` | 1 | `load_reg_field n` | register = object field[n] |
| `$21` | 1 | `wait_field n` | wait timer = object field[n] |
| `$22` | 2 | `set_draw_vec addr` | `$0BFE,X`, default `$80:9E8E` `sub_obj_draw` |
| `$23` | 2 | `set_update_vec addr` | `$0BDE,X`, default `$80:9E5C` |
| `$24` | 1 | `loop_reg` | `loop` with the count from the thread register. Shares `$9655` with `$01`, so **the operand byte is read past and ignored** |
| `$25` | 2 | `set_physics_vec addr` | `$0C1E,X`, default `$80:9E33` |
| `$26` | 1 | `frame_index_field n` | frame index `$0B7E,X` = object field[n] |
| `$27` | 4 | `rmw_reg pad,op,imm16` | register `<op>=` `imm16`. Shares `$9AF5` with `$14`, so **the first operand byte is read past and ignored** |
| `$28` | 2 | `set_x imm16` | `$091E,X` = `imm16`, fraction `$097E,X` = `$8000` |
| `$29` | 2 | `set_y imm16` | `$093E,X` / `$099E,X` |
| `$2A` | 2 | `set_z imm16` | `$095E,X` / `$09BE,X` |
| `$2B` | 2 | `add_x imm16` | `$091E,X` += `imm16` (whole part only) |
| `$2C` | 2 | `add_y imm16` | `$093E,X` += `imm16` |
| `$2D` | 2 | `add_z imm16` | `$095E,X` += `imm16` |
| `$2E` | 2 | `add_vx imm8.8` | X velocity += signed 8.8 |
| `$2F` | 2 | `add_vy imm8.8` | Y velocity += signed 8.8 |
| `$30` | 2 | `add_vz imm8.8` | Z velocity += signed 8.8 |
| `$31` | 3 | `slot_set_a n,imm16` | `$0FBE,X` = `imm16`, `STZ $0FCE,X`, `X` = slot * 2 |
| `$32` | 3 | `slot_set_b n,imm16` | `$0FC6,X` = `imm16`, `STZ $0FD6,X` |
| `$33` | 3 | `slot_set_c n,imm8.8` | `$0FEE,X` / `$0FDE,X` |
| `$34` | 3 | `slot_set_d n,imm8.8` | `$0FF6,X` / `$0FE6,X` |
| `$35` | 3 | `slot_add_c n,imm8.8` | `$0FEE,X` / `$0FDE,X` += |
| `$36` | 3 | `slot_add_d n,imm8.8` | `$0FF6,X` / `$0FE6,X` += |
| `$37` | 3 | `slot_add_a n,imm16` | `$0FBE,X` += |
| `$38` | 3 | `slot_add_b n,imm16` | `$0FC6,X` += |
| `$39` | 0 | `stop` | zero all three velocity pairs, whole and fractional |
| `$3A` | 1 | `slot_clear n` | zero `$0FEE`/`$0FDE`/`$0FF6`/`$0FE6` for one slot |
| `$3B` | 6 | `set_pos x,y,z` | all three positions at once, each fraction `$8000` |
| `$3C` | 1 | `set_queue n` | `$0B1E,X`, the OAM priority queue; `sub_obj_draw` copies it to `$2880` for `sub_oam_enqueue` |

**What is not established.** Operand sizes and the RAM each handler touches
are read straight off the code and are solid. What those RAM words *mean* is
not, in three places:

* `$31`-`$38` and `$3A` address four arrays at `$0FBE`, `$0FC6`, `$0FDE` and
  `$0FE6` (with `$0FCE`, `$0FD6`, `$0FEE`, `$0FF6` as their companions) with
  an index that is *not* the object index — the handlers use the operand byte
  times two directly. They look like a second, independent set of animated
  quantities with the same whole/fraction split the positions use, but which
  subsystem owns them is unknown.
* `$08` / `$0F` write `$0B3E,X`+`$0B5E,X`, a per-object long vector called by
  `$80:9510` inside `sub_obj_tick_all`. `$9D9B` resets it to `$80:94C6`. The
  four known scripts set it to `$81:A2BB` (types 2 and 3) or to a routine
  right after the script itself (types 0 and 1), so it is per-object
  behaviour code, but it has not been read.
* `$0D`, `$12`, `$15`, `$18`, `$1E` take a bare 16-bit address applied with
  whatever DBR the interpreter runs under. They are written here as `$addr`
  with no bank.

The two opcodes that read an operand byte and throw it away — `$24` and `$27`
— are a deduction, not an observation: both jump into the middle of another
handler (`$9655`, `$9AF5`) at a point past that handler's own `LDA [$D0],Y`
but *before* its `INY`. The `INY` still runs, so a byte is skipped. No script
in the corpus emits either opcode, so the padding byte's value is unverified.

## Binding a frame table

Opcode `$1C` is `sub_obj_set_frame_ptr $80:9B98 (0x001B98)`:

```
LDX $D8                 ; object index * 2
LDA [$D0],Y / STA $0B9E,X       ; frame table address
INY / INY
SEP #$20
LDA [$D0],Y / STA $0BBE,X       ; frame table bank
REP #$20 / INY
```

It is **the only `STA $0B9E,X` in the ROM**, so every object that draws
through the first object system got its frame pointer table from a `$1C` in
some script. That makes the three operand bytes a static, greppable link from
code to metasprite data, and it is how `tools/frametabs.py`'s `anim1c` finder
recovers tables — see [graphics.md](graphics.md).

The object then holds a *table plus an index*, never a frame list:

```
$7E:0B9E,X   frame pointer table address      (only $80:9B98 writes it)
$7E:0BBE,X   frame pointer table bank
$7E:0B7E,X   index into it; negative = invisible
```

`sub_obj_draw $80:9E8E` does `ASL A / TAY / LDA [$DC],Y` against that table to
get the frame list, then `JSL $80:8B02` to queue it. Advancing an animation is
just changing the index, which is exactly what wait-actions 0-3 do.

## The four object-type scripts

`tbl_obj_type_scripts $80:9F0C (0x001F0C)`, 12 bytes, four entries of
`addr16, bank8`. `sub_obj_spawn $80:93DD` indexes it with the object type.

| type | script | bytes |
|---|---|---|
| 0 | `$87:9A14 (0x039A14)` | 15 |
| 1 | `$87:9A23 (0x039A23)` | 15 |
| 2 | `$87:99FE (0x0399FE)` | 11 |
| 3 | `$87:9A09 (0x039A09)` | 11 |

They are packed back to back as `dat_anim_scripts_type0_3 $87:99FE`, 52 bytes
in address order 2, 3, 0, 1, and each ends on `$09`:

```
type 2   $87:99FE   08 BB A2 81    set_obj_hook     $81:A2BB
                    1C 51 93 89    set_frame_table  $89:9351
                    80 FF          frame wait=0     $FF  (hidden)
                    09             halt
type 3   $87:9A09   08 BB A2 81    set_obj_hook     $81:A2BB
                    1C 65 93 89    set_frame_table  $89:9365
                    80 FF          frame wait=0     $FF
                    09             halt
type 0   $87:9A14   22 0B 9F       set_draw_vec     $80:9F0B
                    25 0B 9F       set_physics_vec  $80:9F0B
                    1C 95 92 89    set_frame_table  $89:9295
                    08 32 9A 87    set_obj_hook     $87:9A32
                    09             halt
type 1   $87:9A23   22 0B 9F       set_draw_vec     $80:9F0B
                    25 0B 9F       set_physics_vec  $80:9F0B
                    1C F3 92 89    set_frame_table  $89:92F3
                    08 85 9A 87    set_obj_hook     $87:9A85
                    09             halt
```

Three details are worth keeping:

* The vector operands are **bank `$80`** addresses even though the script is
  in bank `$87`: the vectors are reached by `JSR ($0BFE,X)` from
  `sub_obj_tick_all`, which runs in bank `$80`. `$80:9F0B` is a bare `RTS` —
  types 0 and 1 explicitly turn drawing and physics *off* and do all their
  work from the `$08` hook instead.
* All four halt immediately. They are initialisation, not animation: they
  bind a table, set a hook, and stop. Whatever animates these objects does it
  through the `$08` hook or by writing `$0B7E,X` directly.
* The four `$1C` operands are exactly `$89:9295`, `$92F3`, `$9351` and
  `$9365`, the four tables `docs/graphics.md` already named.

`python3 tools/anim.py --verify` asserts all of this: 52 bytes total, each
script ending on `$09`, and every `$1C` operand present in
`build/sprites/tables.tsv`.

## Per-thread and per-object RAM

Threads and objects are separate: 31 threads, 16 objects. `$DA` selects a
thread, `$D8` an object, both pre-multiplied by two.

| address | size | what |
|---|---|---|
| `$7E:0C7E,X` | 31 x 2 | local stack pointer into `ram_anim_locals`; zeroed on spawn |
| `$7E:0CBE,X` | 31 x 2 | wait timer in ticks; `$FFFF` = halted |
| `$7E:0CFE,X` | 31 x 2 | script PC, used as `Y` against `[$D0]` |
| `$7E:0D3E,X` | 31 x 2 | script bank, copied to `$D2` |
| `$7E:0D7E,X` | 31 x 2 | the thread register: the operand of `set_reg`, the subject of every `beq_reg`/`switch`, and the `A` passed to a far call |
| `$7E:0DBE` | 31 x 8 | local stack bytes; `$D4` = `$0DBE + 8*thread` |
| `$7E:0C3E,X` | 31 x 2 | linked/child thread, set by `spawn` and killed by `$13` |
| `$7E:0B7E,X` | 16 x 2 | frame index; negative = invisible |
| `$7E:0B9E,X` | 16 x 2 | frame pointer table address |
| `$7E:0BBE,X` | 16 x 2 | frame pointer table bank |
| `$7E:0B1E,X` | 16 x 2 | OAM priority queue number |
| `$7E:0B3E,X` / `$0B5E,X` | 16 x 2 | the `$08` long hook, addr and bank |
| `$7E:0BDE,X` | 16 x 2 | update vector, `JSR ($0BDE,X)` |
| `$7E:0BFE,X` | 16 x 2 | draw vector, `JSR ($0BFE,X)` |
| `$7E:0C1E,X` | 16 x 2 | physics vector, `JSR ($0C1E,X)` |
| `$7E:091E,X` / `$097E,X` | 16 x 2 | X position, whole and fraction |
| `$7E:093E,X` / `$099E,X` | 16 x 2 | Y position |
| `$7E:095E,X` / `$09BE,X` | 16 x 2 | Z position |
| `$7E:09DE,X` / `$0A3E,X` | 16 x 2 | X velocity, whole and fraction |
| `$7E:09FE,X` / `$0A5E,X` | 16 x 2 | Y velocity |
| `$7E:0A1E,X` / `$0A7E,X` | 16 x 2 | Z velocity |
| `$7E:0A9E`, `$0ABE`, `$0ADE`, `$0AFE` | 16 x 2 each | the four generic `field` words, from `$80:9B4C` |

The local stack is 8 bytes per thread, which bounds nesting hard: a far call
frame is 3 bytes (PC + bank), a near call frame 2, a loop frame 3. Two nested
far calls plus a loop already fill it.

## Thread objects (the second object system)

The arrays around `$7E:5E1C` belong to a second, much larger object system,
and what its frame slot holds is now settled: **both** readings the earlier
version of this section offered are true, for different objects.

A *thread object* is a slot in the arrays at `$7E:4E1C`-`$7E:649C` -- 64
slots, two bytes each, the running slot's index in dp `$D2` (the direct page
is `$1E00` in thread context) -- executing native 65816 code as a coroutine.

| routine | what |
|---|---|
| `sub_thread_spawn $80:DFBA` | A = object type. Reads `tbl_thread_types $80:ED3A`, four bytes per type: entry addr16, bank8, list8. **234 types**; the highest any caller passes is 233 |
| `$80:E4B6`, `$80:E4F2`, `$80:E526` | spawn wrappers that also set the position and install a default draw routine |
| `sub_thread_yield $80:E445` | A = frames to wait. Pops its own return address into the slot, so the thread resumes after the `JSL`. 2,551 call sites |
| `sub_thread_exit $80:E060` | free the slot; reached by `JML` |

| slot field | what |
|---|---|
| `$4E1C` | object type, `$FFFF` = free |
| `$4F9C` / `$501C` | resume address and bank |
| `$509C` / `$511C` | per-frame handler |
| `$519C` / `$521C` | draw routine |
| `$529C` | frames left to wait |
| `$5D9C` | **frame index**, negative = not drawn |
| `$5E1C` | **frame pointer table**, a word address in bank `$89` |
| `$5E9C` | OAM priority queue |
| `$5F1C`, `$5F9C` | X, Y |
| `$641C` / `$649C` | continuation a shared script segment returns through |

The default draw routines (`$80:E55A` world, `$80:E5A2` screen) end in

```
$80:E585  LDA $5D9C,X / BMI skip / ASL A / CLC / ADC $5E1C,X / STA $DE
$80:E591  LDA $009E / STA $E0 / LDA [$DE] / STA $C0
$80:E59A  LDA $5E9C,X / JML $80:8B09
```

table plus twice the index, dereferenced, enqueued. So `$5E1C` is a table
and `$5D9C` the entry. A few objects install their own draw routine
(`$87:8C93`, `$87:932E`, `$87:98AA`: `LDA $5E1C,Y / STA $C0`) and for those
the slot holds a frame *list*. Of the 96 distinct immediates stored to the
slot, 86 are tables and 8 are lists; the bytes tell them apart, see
`classify_obj2` in `tools/frametabs.py`.

### The helpers in RAM

`$80:E67F` copies twelve small routines from `$80:E732`-`$80:E96B` to WRAM
`$1018`-`$120D` at boot. Low addresses are mirrored in every bank, so code
anywhere can reach them with a near `JSR`. They take their operands
**inline**, after the call, and fix up their own return address:

| call | inline bytes | effect |
|---|---|---|
| `JSR $1030` | idx8, frames8 | set the frame index (`$FF` = hide) and yield for `frames`. **924 call sites** -- this is the animation primitive |
| `JSR $1018` | variant8 | spawn another object of the caller's type, `variant` in `$589C` |
| `JSR $105E` | x16, y16 | set the position |
| `JSR $1084`, `$10A3`, `$10C2` | 3 | motion parameters |
| `JSR $10E7` | 4 | motion parameters |
| `JSR $1104` | 9 | all three groups at once |
| `JSR $1151` | 0 | clear them |
| `JSR $116A`, `$119D`, `$11D6` | 6 | pairs of groups |

A disassembler that does not know these runs straight into the operand
bytes; that, not interleaved data, is why linear disassembly of banks
`$83`-`$87` desyncs within a few instructions.

### How an object animates

In two ways at once. It changes the index, and it re-uploads the tiles the
frame points at -- bank `$86` is almost nothing but

```
LDA #idx / STA $5D9C,Y        ; which layout
LDA #blk / JSL $80:8696       ; which tiles (block in the caller's bank)
LDA #n   / JSL $80:E445       ; for how long
```

so a frame's picture is (layout, VRAM contents). `tools/objanim.py` follows
each type's code by recursive descent -- both arms of every branch,
subroutines in banks `$83`-`$87`, `JMP (abs,X)` tables, and the code
pointers a thread plants in its own slot -- and reports these idioms in
address order. From the 234 entry points it reaches 745 of the 890
`sub_vram_queue` call sites and 910 of the 924 `JSR $1030` sites; what it
misses is engine and scene code in banks `$80`-`$83` and the script-driven
objects' code in bank `$87`.

```bash
python3 tools/objanim.py --types       # tbl_thread_types
python3 tools/objanim.py --type 197    # one object's events
python3 tools/objanim.py               # -> build/sprites/objects.tsv, objects/
```

Type 197 at `$86:9340` is the largest: it binds table `$89:9295` (the one
the Kirby object-type script names) with draw routine `$80:E974`, then
dispatches through a 32-entry jump table at `$86:93B0` on `$6A5A` into long
scripted sequences. Its sheet is where whole Kirby frames come from.

**Not established:** how the script-driven Kirby of the previous sections
pairs its frame index with its tile uploads during play. Two sites in bank
`$87` do it with parallel tables (`$87:9E7A`: `LDA $87:9EA5,X / STA $0B7E`
then `LDA $87:9EC5,X / JSL $80:8696`), which is the pattern to look for;
the rest is in the `$08` hook code that has not been read.

## Finding more scripts

`python3 tools/anim.py --scan` walks every `$1C` whose operand is a table in
`build/sprites/tables.tsv`, then walks backwards up to 64 bytes for the
earliest byte that decodes cleanly onto that `$1C` and reaches a terminator.
Candidates whose preceding byte is a `$09` halt win, because the known
scripts are packed back to back that way — that is what picks `$87:9A14` over
`$87:9A0F`, which also decodes cleanly.

It currently recovers exactly the four known scripts and nothing else: the
only `$1C` sites that name a confirmed table are the four in bank `$87`.
Anything it reports beyond those four would be **unconfirmed** — the start
address is a guess, since nothing in the ROM points at it.

The obvious next lead is the `$08` hook. The four known scripts halt straight
away and hand control to `$81:A2BB`, `$87:9A32` and `$87:9A85`; reading those
three routines is what would show where the running animation actually lives.

## Kirby's animation scripts (a third interpreter)

Kirby in play is not animated by either system above. Script object 0
(player 2: object 1) is only the drawing slot; its frame index `$0B7E` is
set by a third bytecode interpreter at `$87:808E`, found by watching the
index with `snesstep --watch-write` (it is written by `$87:81C1` and
`$87:83FE`, the store opcodes, via the per-player state copy at
`$82:F0F8`/`$82:F28B`). Its design is a **state machine per object**:

| field | what |
|---|---|
| `$7E:6830,X` | the script object it animates |
| `$7E:6840,X` | address of a WRAM **state variable** |
| `$7E:6850,X` | the variable's value last frame |
| `$7E:6860,X` | address of a table: state -> script |
| `$7E:6870,X` / `$6880,X` | script PC; frames left to wait |
| `$7E:6890,X` | per-frame native hook, 0 = none |
| `$7E:68A0,X` | return address of a script call |
| `$7E:68B0,X` / `$68C0,X` | loop counter, loop start |

Every frame, for each of up to 8 threads (X = `$D8`), the interpreter
compares the state variable with last frame's value: on a change it jumps
to `table[state]`, otherwise it counts down the wait and resumes. A thread
is started by `sub_kirbyanim_start $87:804C` from a 6-byte descriptor:

| descriptor | object | state variable | table | states |
|---|---|---|---|---|
| `$87:9AD8` | 0 (player 1) | `$7E:D7D4` | `$87:9ADE` | 51 |
| `$87:B98A` | 1 (player 2) | `$7E:D7D6` | `$87:B990` | 51 |
| `$87:D7F7` | 10 | `$7E:D7DE` | `$87:D7FD` | 1 |

So **the state variable is the semantic key**: one number per situation,
one script per number. The 45 opcodes (`$00`-`$58`, even only, dispatched
through `$87:80F4`) show a frame with a hold time, upload tiles through
`sub_vram_queue` (blocks in bank `$87`), load partial palettes, branch,
switch on a WRAM variable, call scripts and native code, loop, do
arithmetic on WRAM, and play sound effects and songs. The full table, with
operand layouts, is the docstring of `tools/kirbyanim.py`.

**Angles are switch arms.** Facing is never a separate animation: a script
switches on a facing variable and each arm uploads different art into the
same tile slots under the same layout. The variables:

| variable | arms | used by |
|---|---|---|
| `$7E:D7C4` | 8 | standing and aiming (states 4, 5) |
| `$7E:D7CC` | 16 | the shot: curling into the ball (state 6) |
| `$7E:D8D2` | 11 | unrolling (state 7) |
| `$7E:D75E`, `$7E:D75A` | 16, 8, 2 | the copy abilities (states 20-36) |

**The curl is drawn by a stand-in.** For about 30 frames from the shot
(state 6, set by `$81:BEF1`), `$84:CA0C` hides script object 0 (index
`$FFFF`) and thread object type 26 (`$84:C9C7`, table `$89:92F3`) draws
Kirby, while state 6's script uploads the curl's tiles. `$84:CAB8` restores
the index afterwards. A renderer that follows only object 0 never sees the
curl.

What each state is, named from where the game sets it and what the live
frames show, is the `STATE_NAMES` table in `tools/kirbyanim.py` and the
`name` and `evidence` columns of `build/sprites/kirby/states.tsv`. **The
names are interpretations.** 28 of the 51 states were seen running (hole 1
and the 20 demos); the rest are named from their script alone or not at
all.

```bash
python3 tools/kirbyanim.py --state 6     # one state's script, decoded
python3 tools/kirbyanim.py --make-base   # snapshot a hole for the static renders
python3 tools/kirbyanim.py               # every state: listing + strips
python3 tools/kirbyanim.py --live        # every state as seen in play (~3 min)
```

Outputs in `build/sprites/kirby/`: `scripts.txt` (every state's script),
`state_NN.png` (each script replayed, one row per arm of its facing switch),
`live_state_NN.png` (the frames seen in play), `live_state_NN_facing.png`
(those frames, one row per facing value) and `states.tsv` / `states.json` /
`live.json`.
