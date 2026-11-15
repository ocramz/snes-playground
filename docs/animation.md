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
`$1018`-`$120E` at boot, one `MVN` each (`$80:E74A`-`$E78C` stays in ROM: it
is the body `$1018` calls). Low addresses are mirrored in every bank, so code
anywhere can reach them with a near `JSR`. They take their operands
**inline**, after the call, read through `PHK` from the caller's bank, and
fix up their own return address. Y is the slot:

| call (ROM) | inline bytes | effect |
|---|---|---|
| `JSR $1030` (`$E78D`) | idx8, frames8 | set the frame index (`$FF` = hide), the resume address and the wait, and return to the scheduler (`RTL`): it must be called at the thread's top level. **924 call sites** -- this is the animation primitive |
| `JSR $1018` (`$E732`) | variant8 | spawn another object of the caller's type (`$80:E74A`): `variant` in `$589C`, the parent's position, `$581C` = the parent's slot, `$611C`-`$629C` zeroed, `$5D9C` = `$FFFF` |
| `JSR $105E` (`$E7BB`) | x16, y16 | set the position `$5F1C`, `$5F9C`; the fractions `$601C`, `$609C` = 0 |
| `JSR $1084` (`$E7E1`) | a8, rate16 | angle 1: `$5A1C` = a << 8, its turn per tick `$5A9C` |
| `JSR $10A3` (`$E800`) | s8, rate16 | speed 1: `$5B1C` = s << 8 (8.8 px a tick), its change per tick `$5B9C` |
| `JSR $10C2` (`$E81F`) | a8, acc16 | angle 2: `$5C1C` = a << 8, the acceleration along it `$5D1C`; its speed `$5C9C` = 0 |
| `JSR $10E7` (`$E844`) | vx16, vy16 | a constant velocity `$591C`, `$599C` |
| `JSR $1104` (`$E861`) | 9 | `$1084`, `$10A3` and `$10C2` at once |
| `JSR $1151` (`$E8AE`) | 0 | clear the three groups (not `$591C`/`$599C`) |
| `JSR $116A`, `$119D`, `$11D6` | 6 | pairs: `$1084`+`$10A3`, `$1084`+`$10C2`, `$10A3`+`$10C2` |

The bytes land in the high byte (`AND #$FF / XBA`), unsigned; the words are
signed 8.8. `$80:E710` (`JSL`) clears all of them and `$639C`. Nothing in
the slot's per-frame handler moves the object: the draw routines
`$80:E96C` (world) and `$80:E974` (screen) do, through `$80:E97C`, before
`$80:E55A`/`$80:E5A2` integrate and draw:

```
v = 0
if $5B1C: v = polar($5B1C, $5A1C >> 8)
if $5A1C | $5B1C: $5A1C += $5A9C; $5B1C += $5B9C        ; after the use
if $591C | $599C: v += ($591C, $599C)
if $5D1C: v += polar($5C9C, $5C1C >> 8); $5C9C += $5D1C
$80:E5E2: {$5F9C:$609C} += sext(v.y), then {$5F1C:$601C} += sext(v.x)   ; 16.16, carry through

polar(r, a) ($80:EA26): r6 = r >> 6 (arithmetic);
  dx = (low 16 bits of r6 * T[a]) >> 2, dy = (... * T[a + 64]) >> 2 (arithmetic)
  T = $80:EABA, 320 signed words (cos by angle 0-255, 256 = 1); $80:EA76 builds
  the 16-bit product from three 8x8 products of $4202/$4203
```

Angle 0 is right, `$40` up (y grows down the screen). T is a table, not a
formula: T[63] = 2 and T[319] = 0. The motion runs every tick the slot draws,
hidden or not; the exit tick (`$80:E060` frees the slot before the draw pass)
does neither. `$80:E55A` draws at the position minus the scroll (`$86`,
`$88`) and skips it outside [-48, 296) × [-32, 280) or with `$5D9C` < 0.

**The scheduler's timing** (`$80:E0C0`, once per main-loop iteration): for
each list, the threads whose wait `$529C` underflows (`DEC`/`BPL`) resume,
then every slot's per-frame handler and draw routine run. A list that grew
during the tick gets both passes again for the new slots only. So a yield
of n (`$80:E445` stores n) resumes n + 1 ticks later, `JSR $1030 idx,n`
shows idx for n + 1 ticks, and a slot spawned before or during the tick
(`$80:DFBA` sets its wait to 0) runs its thread and its draw in that tick.

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

### Objects 61 and 62: the snap panels' stars

Read 2026-11-15 (notes/port-v2-phase3-snaps.md); ported as
`engine/src/core/sim/snap-stars.ts`, checked against the slots recorded
with `tools/snesstep/trace_actors.py --types 61,62` (`snap-stars.test.ts`).
Both are on list 3 (`$80:EE2E`).

**Object 61** (`$85:CF2D`), spawned by the snap push once a pass
([tiles.md](tiles.md) "Snap panels"), never draws (`$519C` stays 0):

```
loop: $699A = $FFFF; $6998 = $551C,Y (the player x 2)
      JSR $CF4E                        ; the burst
      yield 7                          ; 8 ticks
      if $699A == 0: loop              ; a push cleared it meanwhile
      exit
```

`$CF4E`: the work copy's tile `$DA0A` in `$18-$1B` and the block's
velocity along the panel's arrow (`$18` `$D87E` < 0, `$19` `$D87A` ≥ 0,
`$1A` `$D87E` ≥ 0, `$1B` `$D87A` < 0, by `$6998`), else nothing. Then four
object 62s through `$80:E4F2`, `$531C` = 3, 2, 1, 0, each given:
- `$589C` = `$D9DE`, the heading in 16ths;
- `$5F1C`/`$5F9C` = `$091E,X`/`$093E,X`, Kirby's projected point (`$81:A21E`:
  `$DA58`, `$8B9A` - `$DA5C`, course-bitmap pixels);
- the OAM queue `$5E9C` = Kirby's `$0B1E,X`, + 1 when the heading is < 3 or
  ≥ 11;
- the draw routine `$80:E96C`.

The stars do not follow the ball after that. If the latch re-arms while an
object 61 lives, a second one shares `$6998`/`$6996`/`$699A` with it.

**Object 62** (`$85:CFE1`): `$80:E710`, then `JMP ($CFF2,X)` by `$589C` and
a 13-byte dispatcher on `$531C` (`LDA $531C,Y / CMP #4 / BCS self / ASL /
TAX / JMP (tbl,X)`) into one of 64 scripts packed at `$85:D027`-`$E08D`, no
two alike. Each sets table `$89:9485`, then uses only `JSR $1104` (turn
rate and speed change always 0: a launch at speed s along angle 1, plus an
acceleration along angle 2) and `JSR $1030`, and exits through `$80:E060`.
Some start hidden for 2-12 ticks; a star is drawn for 18-26 ticks, then freed. The engine
reads them from the ROM (tables.json `snapStars`, `tools/export_web.py`'s
`snap_star_scripts`, which fails on any other form).

Pictures: table `$89:9485` indices 0-4, one 8×8 part each, tiles `$005`,
`$004`, `$003` (palette 2) and `$001`, `$002` (palette 3). Lists 0-2 open
with `$7E $DA74`, Kirby's priority, so those frames go behind the course
with him; 3 and 4 stay at priority 3. The emulated sheet is
`build/sprites/emu/obj_062.json`. `obj_061.json` is not object 61's: it
never draws, and emusheets caught a stale `$5E1C` in its slot (it does not
skip a draw routine of 0).

*Emulated* (web_snap, the first burst at 2498, dir 12): variants 1 and 0
rise from (907, 179) at once, 3 and 2 wait hidden, all four are freed 20
ticks on (2518), and the next burst comes 8 ticks after the first (2506).

### The water's objects: 53-58 and 67

Read 2026-11-15 (notes/port-v2-phase4-water.md); ported as
`engine/src/core/sim/water-fx.ts`, checked against the slots recorded with
`tools/snesstep/trace_actors.py --types 53,54,55,56,57,58,67`
(`engine/test/water-fx.test.ts`). The water's handlers spawn them
([tiles.md](tiles.md) "Water") through `$80:E4F2`, `$531C` = the player.

**The splashes** (`$85:8E5A`-`$85:8FFB`, list 6, frame table `$89:94DB`)
are straight lines. At their first run each takes Kirby's projected point
(`$091E,X`/`$093E,X`, as the stars do) and his OAM queue `$0B1E,X`, then
shows frames and yields, and ends. A wait of n shows n + 1 ticks.

| object | spawned by | frames × ticks |
|---|---|---|
| 53 | a slow skim, the modifier's bounce | queue + 1: 5 × 6, 3 × 5 |
| 54 | a skip, a fast skim | 4 × 3, then queue + 1, 4 × 3, 5 × 5, 3 × 5 |
| 55 | an entry or a way out with \|vz\| < `$110` | 0 × 6, 1 × 5, 3 × 5 |
| 56 | the same, \|vz\| from `$110` | 0 × 6, 1 × 5, 2 × 5, 3 × 5 |
| 57 | the same, from `$1F0` | spawns 58 at its point, then 56's code |
| 58 | 57 | 6 × 3, then 7-12 × 5 each: the drops |

tables.json `waterFx` keeps them as ops (`tools/export_web.py`
`water_fx_scripts`, which fails on any other form).

**Object 67** (`$85:E76B`) is a bubble emitter. An entry spawns two
(`$82:85DD`), with `$539C` = 4 and 12, its first wait. After it the emitter
installs its hook `$85:E836`, which sets `$549C` once the block's `$D872` is
clear, and loops (`$85:E78D`):

    $549C set: exit
    the water iced ($69DA & $D872) or no tomatoes: wait 1 tick
    Kirby standing ($D842, the set-up to the roll's start):
        a bubble at his point + $85:E845/$E855[facing], queue + $85:E865[facing]
    the ball airborne: wait 1 tick
    else: a bubble at the ball (his point)

A bubble (`$85:E8FC`) is the slot itself, offset by a random pair
(`$80:87DD` & 7, `$85:EA2F`). The point is added as
`CLC / ADC point / ADC offset`, so the first add's carry counts.
Then it runs the rise (`$85:E934`):
- frames 0-3 of `$89:952B`, with velocities that slow the rise to −0.75 px a
  tick and sway x by ±0.5;
- hidden;
- the continuation `$85:E800`: a random wait of `$85:E87D`[`$85:E875`[rng &
  7] × 2 + 6 × toggle], then the loop.

The index × 2 runs past the six-byte table into the code after it, so the
waits alternate between {120, 60, 30} and {185, 83, 69} ticks.

Its draw routine is `$80:E55A` (from `$80:E4F2`). It integrates the velocity
every tick, y then x, and the fractions carry from bubble to bubble.

*Emulated*, every scenario and web_water_shot: each splash's frames and
point, and each bubble's, with the engine's random state seeded from the
recording at the set-up. In a 1P hole only the bubbles and the hole's
opening (`$84:B871`) call `$80:87DD`.

Pictures: all palette 0, the same as Kirby's, but only colours 8-15, so
the water's palette swap leaves them as they are (notes). They are
priority 3. In Kirby's queue they cover him: the entry's crown is over his
lower half (web_water_shot 2763, `tools/ppu_render.py`). One queue back
they are behind him.

**Kirby in the water.** `$82:8604` writes OBJ palette 0's colours 2-8 from
`$98:C796` (wet) or `$98:C77A` (dry; player 2's `$98:C7A4`/`$C788` at `$92`)
whenever `$D9EE` changes in a handler. The thread hook `$84:9A38` rewrites
colour 7 (the outline) every frame from `$98:D4A8`: `$0C63` in mode 0 and
whenever the ball is in the water. So only colours 2-6 change on screen.
The shot guide in the water draws `$89:8F52` (a rolling dot), `$89:8F39`
(airborne) and `$89:8F6B` (the end) in palette 0, instead of the dry
lists' palettes 3 and 1 (`$81:ACDB`, `$81:ACF6`, `$81:ADF6`).

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

| variable | arms | what the value is |
|---|---|---|
| `$7E:D7C4` | 8 | Kirby's facing: aiming, waiting (states 4, 5, 9). From the aim phi: `$81:BB4A` stores `(472 - phi) mod 360` in `$6ABE`, `$81:BCA0` reads `$81:8E98[$6ABE]` (32 sectors of 11.25°; the table is also the heading → 32 directions table) and keeps `>> 2`. phi 0 (+x) gives 2, phi 90 gives 0, 180 gives 6, 270 gives 4. Screen direction `45 - 45·v` degrees (0 = right, counter-clockwise): 0 up-right, 1 right, 2 down-right, 3 down (faces the camera), 7 up. *Emulated*: 340 frames of an aim sweep match the table exactly |
| `$7E:D7CC` | 16 | the shot's angle: the curl and the unroll (6, 7). The same 32-sector value `>> 1` (phi 0 gives 5, phi 90 gives 1, 180 gives 13, 270 gives 9), so `k` is the facing `k >> 1` refined to half octants; screen direction about `45 - 22.5·k` degrees. *Emulated*, same sweep |
| `$7E:D85A` | 11 | the copy ability (state 8): 0 none, 1 Stone, 2 Parasol, 3 Fireball, 4 Needle, 5 Tornado, 6 Wheel, 7 Spark, 8 Hi-Jump, 9 Freeze, 10 UFO. The order is `$82:C90A`'s jump table, which sets each ability's state, and matches demos 10-19. Values 12-21 are hit codes (below) |
| `$7E:D7F0` | 3 | Kirby's health (state 11): 4 at a hole's start, -1 per shot (`$83:AC12`), +1 per enemy (`$83:AC01`) -- *emulated*, hole1long |
| `$7E:D8A6` | 2 | 0 on the ground, 1 airborne (state 13) |
| `$7E:D78C` | 5 | hit code - 12 (state 40): 0 Fireball, 3 Spark reach it |
| `$7E:D75E` | 16 / 9 | copy-ability direction index (`$82:D8A8` copies `$DA04`); degrees not established |
| `$7E:D75A` | 2 / 8 / 16 | per ability: a 2-way variant (Stone, Needle, Hi-Jump), the UFO's 8 poses, and in 33/34 the tornado's **spin phase**, which the script itself steps (`inc`, `and #$0F`) every frame |
| `$7E:D8D2`, `$7E:6A6E` | 11 | squash variant of the ball (6, 7, 12); meaning unknown |

**The curl is drawn by a stand-in.** For about 30 frames from the shot
(state 6, set by `$81:BEF1`), `$84:CA0C` hides script object 0 (index
`$FFFF`) and thread object type 26 (`$84:C9C7`, table `$89:92F3`) draws
Kirby, while state 6's script uploads the curl's tiles. `$84:CAB8`
restores the index afterwards. A renderer that follows only object 0
never sees the curl.

**The state table.** Every writer of `$7E:D7D4` was found two ways: the
`STA $D7D4,X` sites in the ROM (an immediate load before each, so the
value is readable) and `snesstep --watch-write '$7E:D7D4-$7E:D7D5'` over
recorded runs. *seen* says how the pictures were obtained: **play**, the
game reached it in a recorded run (run and frame in the evidence);
**forced**, no run reached it, so the state was poked into `$7E:D7D4` at
`$82:C851` (the start of hole 1's roll, which leaves the state alone until
frame 3401) or `$81:A807` (aiming) and the game's own interpreter ran the
script -- the pictures are the game's, the situation is not; **script**,
never shown, described from the script. Runs: *full game* is
`build/emu/autoplay/game` (135,000 frames; its ball moves are teleports,
so no shot ever ends on the course and only states 0, 1, 3, 4, 6, 12, 13,
14, 30 occur); *hole1long* is hole 1 with A pressed every 60 frames;
*2P* is `inputs/two_player.txt` plus A presses; *dNN* is DEMOPLAY demo
NN. The names are interpretations of those pictures and of the setting
code. The `STATES` table in `tools/kirbyanim.py` is the source.

| state | name | seen | switch | clips | evidence |
|---|---|---|---|---|---|
| 0 | hold: no script | play | - | - | script `$87:9B44` is a bare halt, so the pose is whatever was last shown; set by `$80:C4CE` as each hole starts (63 times in the full game); during the hole intro Kirby is drawn by thread object 104 instead (riding the warp star 105, then jumping off; docs/web-demo.md) |
| 1 | holed out: no script | play | - | - | same script as 0; set by `$82:AEDB`/`$82:B041` when the ball is holed (64 times in the full game, from 13 or 14); script object 0 is not drawn from 3 frames after the hole-out, and Kirby reappears as thread object 129 on the star 128 (docs/web-demo.md) |
| 2 | hold the pose a script left | play | - | - | same script as 0; stored by the scripts of 8, 20 and by `$85:B4D2` (parasol); stone alternates 20/2 every frame (d10 2066-2096) |
| 3 | hold for native code | play | - | - | same script as 0; set by `$82:DA4D` when a copy ability is taken (d10 2065, just before the ability's state; Spark has no state of its own and stays here, d16 2202), by `$82:E221` when health runs out (hole1long 7195), `$87:9239`, `$87:E8D8` |
| 4 | aim, standing still | play | `$7E:D7C4` (8) | 8 script | set every frame by `$81:A804` while aiming with no d-pad/L/R held; switch on the facing `$7E:D7C4` |
| 5 | aim, turning | play | `$7E:D7C4` (8) | 8 script | `$81:A804` while the d-pad or L/R is held (`$67` & `$0F00`, `$6B` & `$30`); alternates with 4 in d01-d04 |
| 6 | curl into the ball at the shot | play | `$7E:D7CC` (16) | 16 live | `$81:BEF1` at the shot (hole 1 frame 2823); switch on the shot angle `$7E:D7CC`; drawn by object type 26 while it runs |
| 7 | unroll after the ball stops | play | `$7E:D7CC` (16) | 16 script | `$81:C08F` when the ball comes to rest (d00 frame 1876, d05 2912): squash, Kirby unrolls, stands; then 4. **Not reached in a normal 1P shot** (web_flow, hole 1: state 14 until `$81:A804` sets 4, 35 frames after the shot is over; only the DEMOPLAY demos go through 7) |
| 8 | copy ability gained | play | `$7E:D85A` (11) | 11 live | `$82:D9E9` on swallowing an enemy (demos 10-19); switch on the ability `$7E:D85A`; flashes and the ability's first pose; ends in 2 |
| 9 | stand and wait for the next turn | play | `$7E:D7C4` (8) | 8 script | `$80:C756` at the end of a shot, dropping the copy ability unless `$80:DEFD` keeps it; 2P run frame 2744 (player 1 waits while player 2 shoots), held 183+ frames; switch on the facing `$7E:D7C4` |
| 10 | fall asleep | forced | - | 1 script | `$80:C7E6` at the end of a shot when health `$7E:D7F0` is 0 and `$6932` is 0; not reached in play; forced: eyes closed, slow breathing 48/8/64/8 frames, sfx 51 three times |
| 11 | tired, panting (low health) | play | `$7E:D7F0` (3) | 3 script | `$80:C7AE` at the end of a shot when health `$7E:D7F0` is 1 or 2; hole1long 5598 (health 2: one pant) and 6356 (health 1: four pants); switch on `$7E:D7F0` |
| 12 | ball squashed on a bounce | play | `$7E:6A6E` (11) | 11 script | `$81:8CA2` for 4 frames, back to 14 by `$81:8CD2` (d02 2931, d07 2176); switch on `$7E:6A6E` |
| 13 | hop (A pressed mid-roll) | play | `$7E:D8A6` (2) | 2 script | `$82:DAAE` on each A press while rolling (hole1long 3920, 3980, ... every 60 frames, as pressed); its script returns to 14 after 17 frames; call switch on `$7E:D8A6` |
| 14 | ball rolling | play | - | 1 script | `$82:C84E` at the start of the roll (hole 1 frame 2984) when max(/`$6B54`-6/, /`$6B58`-6/) < 3; restored by many routines |
| 15 | ball rolling, strong spin | play | - | 1 script | `$82:C84E` when max(/`$6B54`-6/, /`$6B58`-6/) >= 4 (d06 2088 with `$6B58` = 0; d09 3487 with `$6B54` = 0; web_fly_spin, web_ui); `$6B54`/`$6B58` are the side and top/back selectors latched at the shot (below, "Kirby's poses in play") |
| 16 | ball rolling, medium spin | play | - | 1 script | `$82:C843` when that maximum is exactly 3; web_fly latches top/back 3 and rolls in 16 (the engine's flow test); also forced: ball with spin streaks |
| 17 | ball rolling, fast (1-frame steps) | forced | - | 1 script | no writer found in the ROM; not seen in play; script: blocks `$87:ABD8-$ABF3`, 1 frame each |
| 18 | ball rolling (2-frame steps) | forced | - | 1 script | no writer found in the ROM; not seen in play; same blocks as 17, 2 frames each |
| 19 | ball sinking | forced | - | 1 script | the ball goes into the water with its ability lost, each counting `$D76C`: `$82:D87A`, Freeze's ice under the ball (`$69DA`, `$69D8` set, `$69CA` clear) gives way, `$D9EE` = 1; `$82:D936`/`$82:E1B0`, an ability active (`$D9C6` 1-11) as the ball enters the water (`$82:CDC5`/`$82:DE3B`: `$D9EE` set, `$DA0E` clear), mode and `$D9C6` back to 0 (read 2026-11-15, tiles.md "Water"); never in mode 0; not reached in play; forced in a roll: a dark disc rises over the ball in 4 steps of 4 frames, then 14 |
| 20 | stone | play | `$7E:D75A` (2), `$7E:D75E` (9) | 18 script | `$82:C95B` (ability 1, d10 2065), then 20/2 alternate every frame (`$82:D5D5` and the script's store) |
| 21 | fireball | play | `$7E:D75E` (16) | 16 script | `$82:CA4D` (d12 2233); switch on `$7E:D75E` |
| 22 | needle | play | `$7E:D75A` (2), `$7E:D75E` (9) | 18 script | `$82:CAF7` (d13 2109) |
| 23 | needle (same script as 22) | script | `$7E:D75A` (2), `$7E:D75E` (9) | 18 script | no writer found in the ROM; not seen; entry `$87:A621` = 22's |
| 24 | hi-jump: take-off | play | `$7E:D75A` (2), `$7E:D75E` (16) | 32 script | `$82:CC80` (d17 2051) |
| 25 | hi-jump: in the air | play | `$7E:D75E` (16) | 16 script | `$82:D1F8` (d17 2108) |
| 26 | wheel: start | play | `$7E:D75E` (16) | 16 script | `$82:CBBC` (d15 1969) |
| 27 | wheel: rolling | play | `$7E:D75E` (16) | 16 script | `$82:D09B` (d15 2009) |
| 28 | wheel: stop | play | - | 1 script | `$82:D127` (d15 2061) |
| 29 | parasol: open | play | - | 1 script | `$82:C9A1` (d11 2190) |
| 30 | parasol: floating | play | - | 1 script | `$85:B342`/`$85:B63F` (d11 2250, 3090); also `$86:A991` before hole 1 (frame 1974) |
| 31 | parasol: other pose | forced | - | 1 script | `$85:B425` (parasol object); not reached in play; script uploads `$87:B955` under the index the previous state left |
| 32 | tornado: start | play | - | 1 script | `$82:CB6D` (d14 1991) |
| 33 | tornado: spinning | play | - | 1 script | `$82:D72A` by speed (table `$82:D790`), d14 2035 |
| 34 | tornado: slowing | play | - | 1 script | `$82:D72A`, d14 2682 |
| 35 | tornado: stop, back to the ball | forced | - | 1 script | `$82:D6E3` when the tornado's speed reaches 0; not reached in play; index 13 for 20 frames, then 14 |
| 36 | freeze | play | `$7E:D75E` (9) | 9 script | `$82:CCDB` (d18 2002) |
| 37 | UFO | play | `$7E:D75A` (8) | 8 script | `$82:CD07` (d19 2125) |
| 38 | UFO: end (empty script) | script | - | - | `$82:D8D3` on the UFO path; the script is a bare halt |
| 39 | UFO: wearing off | play | - | 1 script | `$82:D8EA`/`$82:D31A`/`$82:D34D` (d19 3000, after 37): the UFO's eyes flash, frames 41/42 every 6 frames, until `$82:D90C` sets 14 (d19 3087) |
| 40 | hit: burning / electrocuted | play | `$7E:D78C` (5) | 5 script | `$82:DC11` from the hit dispatch `$82:DBDE` (code `$D85A` - 12 in `$7E:D78C`: 0 = Fireball, 3 = Spark); codes come from the other player's ability via `$80:DF29`/`$80:DF55` (`$82:DB79`, ball contact). In 1P a volcano's base while it spews asks for code `$0F` (15): state 40 at web_hazad 2477 ([tiles.md](tiles.md) "Hazards"); its arm would be 3 by the code - 12 rule (inferred, `$D78C` not watched); forced: Kirby in flames (arm 3: sparks) |
| 41 | spinning, eyes shut | forced | - | 1 script | `$82:DE8F`, the shooter's side of a Fireball/Spark hit (codes 12/15 in `$D9C6`) once `$DA4E` is set; 40 frames, then 14; not reached in play |
| 42 | hit: spun round (Tornado) | forced | - | 1 script | `$82:DC31`, hit code 13 (Tornado); not reached in play; forced: Kirby turns through 16 facings |
| 43 | hit: run over (Wheel) | forced | setter index (4) | 4 script | `$82:DC66`, hit code 14 (Wheel); index 19-22 from `$82:DCA1` by the wheel's direction; not reached in play; forced: flattened, star-eyed |
| 44 | hit: frozen in ice (Freeze) | forced | - | 1 script | `$82:DCBF`, hit code 16 (Freeze); not reached in play; forced: Kirby turns blue and an ice block closes round him |
| 45 | thaw | forced | - | 1 script | `$80:C898` at the end of a shot while frozen (`$D85A` = 16) and `$82:E1DB`; not reached in play; forced: ice shatters, Kirby shivers purple, pink again |
| 46 | hit: squashed (Stone from above) | forced | - | 1 script | `$82:DD0B`, hit code 17 (Stone in the air); index 20; not reached in play; forced: flattened, star-eyed |
| 47 | red-faced | forced | - | 1 script | `$82:E03F`, the Stone user's side after hit code 17 (`$82:E00D`), after a 90-frame pause; the other ball is thrown up; palette `$98:C7BE`; not reached in play |
| 48 | recover from red | forced | - | 1 live | `$82:E0BA` after 47; palette fades back (`$98:C7CA-$C7FA`), then the native call `$87:9E62` (forced run: 9 follows); not reached in play |
| 49 | dizzy (bumped) | play | - | 1 script | `$82:DD73` (code 19) and `$82:DDA1` (code 20, ball-to-ball bump); d08 2372: black/white flash, then spinning eyes, then 14. In 1P the hazard bumpers ask for code `$14` (20) after their bounce (web_haz98; tiles.md "Hazards") |
| 50 | plain ball | forced | - | 1 script | `$82:DDE7`, hit code 21 (from `$82:A4DB`); shows index 0 with block `$87:AB7E`; not reached in play |

Notes on what the table rests on:

* **States 0-3 and 38 have no animation**: their script is a bare `halt`
  (0-3 all point at `$87:9B44`). The picture is whatever was shown last,
  or native code draws Kirby. The old names "stone: transform" and
  "spark: charged ball" for 2 and 3 described what was on screen while
  these do-nothing states were set.
* **4 vs 5** is the d-pad: `$81:A7E6`-`$A804` stores 5 while a direction
  or L/R is held, else 4.
* **13 is the hop on A** (not "in the air"): in hole1long it is set on
  every press, 60 frames apart, and its script returns to 14 after 17
  frames.
* **14 / 16 / 15** are chosen at the start of the roll by
  `$82:C815`-`$C84E` from the spin selectors latched at the shot,
  `$6B54`/`$6B58` (0-12, 6 centred): the larger distance from 6 below 3,
  exactly 3, or 4 and more. A grounder always rolls in 14 (`$82:C808`:
  `$6AD8` set). 17 and 18 have no writer in the ROM.
* **Hit reactions 40-50** are dispatched by `$82:DB9A`: a code in
  `$D85A` of 12-21 indexes `$82:DBDE` (code - 12 also goes to
  `$7E:D78C`). Codes 12-17 come from the *other* player's copy ability
  through `$80:DF29` (airborne) / `$80:DF55` (on the ground) at `$82:DB79`,
  called on ball-to-ball contact (`$82:C693`): Fireball 12 -> 40 (arm 0),
  Tornado 13 -> 42, Wheel 14 -> 43, Spark 15 -> 40 (arm 3), Freeze 16 ->
  44, Stone in the air 17 -> 46, Stone on the ground 20 -> 49. Code 19
  (`$82:DD39`) and 20 also give 49 (d08, the only one of them seen); code
  21 (`$82:A4DB`) gives 50. 41, 47 and 48 are the attacker's side, from
  `$82:DE54` (Fireball/Spark) and `$82:E00D` (Stone).
* **The scripts store the frame index too**: `store $7E:D95E, n` (player 2:
  `$D960`) is a show, because `$82:F0F8` copies that word into the drawing
  slot's `$0B7E` each frame while the ball is in play. 50 stores and 10
  store-switches do this. A `store $7E:D7D4, n` is a state change, taken
  on the next frame (19, 35, 13 and 49 hand over to 14; 8 and 20 to 2).

### Kirby's poses in play

Where a 1-player turn sets `$7E:D7D4`, in order. It is from the
disassembly read for the engine port, which writes the pose at the same
sites; the engine's flow tests compare it with web_flow, web_ui, web_fly,
web_fly_spin, web_hole and web_tomatoes within ±2 frames
([flow.md](flow.md) has the frames):

| state | set by | when |
|---|---|---|
| 0 | `$80:C4CE` | the hole's start; the intro draws Kirby as objects 104/105 |
| 4 / 5 | `$81:A7E6`-`$81:A804` | each aim iteration; 4 also on the aim's A (`$81:A780`). `$80:C60A`'s store of 4 at the set-up goes through a stale X and shows no change |
| 6 | `$81:BEF1` | the frame after a pan to the shot view finds the camera there (`$6AB0`); held through the spin and power stages |
| 14 / 15 / 16 | `$82:C808`-`$82:C84E` | the roll's start (the latch + 22): a grounder 14; a fly shot by the latched spin, as above |
| 12 | `$81:8CA2` | a hit-stop (4 frames on a landing, 2 on a step hit; physics.md); the variant `$6A6E` is the request's A. Back to 14 at `$81:8CD2` unless it was 13 |
| 13 | `$82:DAAE` | an A press while rolling, when on the ground or in the air with no spin pending (physics.md "Buttons while the ball moves"); its script returns to 14 after 17 frames |
| 14 | `$82:CE07` | an airborne bounce, unless hopping (`$82:CE24`) |
| 49 / 40 | `$82:DB9A` | a hazard's reaction after the step: the bumpers (code `$14`), a volcano's base (`$0F`) |
| 1 | `$82:AEDB` | the sink's end (holed 2; physics.md "Enemies and the cup") |
| 11 | `$80:C7AE` | the turn top with 1 or 2 tomatoes, after the pan toward Kirby (`$80:C79A`; flow.md "The set-up") |
| 3 | `$82:E221` | out of tomatoes, 15 frames into `$82:E1EE`; object `$BE` then draws Kirby falling asleep until it is done (flow.md) |
| 4 | `$81:A804` | the next aim; no unroll (7) and no wait pose (9) in a 1P shot |

## Kirby animation clips

`python3 tools/kirbyanim.py --clips` writes one clip per state and switch
arm to `build/sprites/kirby/clips/`: 284 clips over 46 states (0-3 and 38
have nothing to show).

**How a clip is made.** The state's script is replayed from its entry
(`Player` in kirbyanim.py) on the base snapshot's OBJ page and CGRAM, with
the switch variables set to the arm: every upload, palette load, show,
index store, wait and WRAM arithmetic is followed, and the replay stops
when the script halts, hands over to another state, or comes back to a
point it already yielded at with the same index, call stack, loop
counters and variables (a loop; `loop_start` is where the cycle restarts).
Which variables are enumerated: all the script switches on, as a product
when that is at most 36 clips, else the first; a variable the script
steps itself (the tornado's phase) is not an arm. Some states need
context:

* a copy-ability state is replayed after state 8 with its ability, so
  the ability's tiles and palette are loaded; 25, 27, 28, 31, 33-35, 39
  after the states that precede them in play;
* 21, 36, 37, 39 get their colours from native code, so they are replayed
  on a snapshot of their demo a few frames in (`CONTEXT_BASE`);
* 43's frame index is left by its setter (19-22 by the wheel's
  direction, `$82:DCA1`): a pseudo-switch `index`.

A clip comes from the running game instead (`source: "live"`) when the
replay cannot draw it: any frame uses a tile no replayed upload wrote, or
the state is 6 (the curl is drawn by object type 26 from its own frame
list). Live clips are captured frame by frame with the state forced at
the start of hole 1's roll (switch variables poked alongside), or for 6
at the shot with the angle poked at `$81:BEF1`; durations are counted,
and include the one-frame in-betweens the game really shows when an
index changes a frame before its tiles arrive. 28 clips are live: the 16
curls, the 11 ability flashes (in play the per-frame index copy
overrides most of the ability pose: the ball flashes, the pose shows for
single frames, as in demos 10-19) and 48.

**Files.**

| file | what |
|---|---|
| `NAME.gif` | the clip at 3x, transparent background, one canvas per state (all its clips share the origin); delays rounded to 1/100 s; loops forever if `loop`, else plays once |
| `NAME.png` | horizontal strip at 1x, one cell per frame, cell size `cell`, origin at `origin` in each cell |
| `frames/HASH.png` | each distinct picture once, cropped to the frame |
| `clips.json` | the index |
| `clips_index.png` | contact sheet: first frame of every clip, state, `L` = live, frame count, `loop` |

Names are `<slug>_<arm>`: `aim_facing3`, `curl_into_ball_angle07`,
`unroll_angle12`, `ability_gained_fireball`, `tired_health1`, `hop_air`,
`hit_burn_spark`, `stone_var1_dir04`, `hit_flattened_index21`.

**`clips.json`**: `states` (number -> name, slug, seen, evidence),
`no_clip` (states without a picture, and why) and `clips`, each with

| key | |
|---|---|
| `name`, `state`, `state_name`, `seen`, `script` | identity; `script` is the entry in bank `$87` |
| `switches` | per enumerated variable: `var`, `name`, `value`, `arms`, `meaning`, `arm_name` (ability, hit code, ground/air), `degrees` (facing and shot angle, estimated) |
| `fixed`, `prelude` | variables pinned, states replayed first |
| `frames` | `png`, `duration` (60 Hz frames), `x`/`y` (top-left of the png relative to the sprite origin), `w`/`h`, `list` (the `$89` part list), `index` |
| `loop`, `loop_start`, `stop`, `next_state` | once or looping; why the replay stopped; the state it hands over to |
| `source` | `script` or `live`; live clips add `live` (run, pokes, frames), `why_live`, `live_next_state` |
| `static_frames_with_base_tiles` | frames of the replay drawing tiles it did not upload |
| `gif`, `gif_scale`, `strip`, `cell`, `origin`, `total_frames` | the files and their geometry |
| `same_as` | an earlier clip with identical pictures and timing (54 such, e.g. arms that share art) |

Durations are the scripts' wait operands: a `wait n` holds the picture
for `n` frames, checked against the emulator (state 10's 48/8/64/8 and
state 11's 8/6/16/6 measured exactly in hole1long and a forced run).

```bash
python3 tools/kirbyanim.py --state 6     # one state's script, decoded
python3 tools/kirbyanim.py --make-base   # snapshot a hole for the static renders
python3 tools/kirbyanim.py               # every state: listing + strips
python3 tools/kirbyanim.py --clips       # every state x arm -> clips/ (~1 min)
python3 tools/kirbyanim.py --clips --no-live   # script replays only, no emulator
python3 tools/kirbyanim.py --live        # every state as seen in play (~3 min)
```

Other outputs in `build/sprites/kirby/`: `scripts.txt` (every state's
script), `state_NN.png` (each script replayed, one row per arm of its
first switch), `live_state_NN.png` (the frames seen in play),
`live_state_NN_facing.png` (those frames, one row per facing value) and
`states.tsv` / `states.json` / `live.json`.

**Unknown.** What the 11
squash variants of `$7E:D8D2`/`$6A6E` mean; the degrees of the
copy-ability directions `$7E:D75E`; where states 17, 18 and 23 are set
(no writer found); what situation 31 (parasol) is in play; 10, 19, 31,
35, 41-48 and 50 were only seen forced (19 is the water's with an ability,
above).
