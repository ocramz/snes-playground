#!/usr/bin/env python3
"""Kirby's animation scripts: decode them, name them, render them.

Kirby in play is drawn by script object 0 (player 2: object 1), whose frame
index `$7E:0B7E` is set by a third bytecode interpreter, separate from the
two in docs/animation.md. It lives at `$87:808E` and runs up to 8 threads,
fields at `$7E:6830`-`$68C0` (thread X = `$D8`, script pointer `[$D0]`,
bank `$87`):

    $6830,X  the script object it animates (0 = player 1, 2 = player 2)
    $6840,X  address of a WRAM **state variable**
    $6850,X  the value it had last frame
    $6860,X  address of a table: state -> script
    $6870,X  script PC          $6880,X  frames left to wait
    $6890,X  per-frame native hook, 0 = none
    $68A0,X  return address of a script call
    $68B0,X / $68C0,X  loop counter and loop start

Every frame, for each thread: when the state variable differs from last
frame's value the thread jumps to `table[state]`; otherwise it counts down
its wait and, at zero, resumes the script. So **the state variable is the
semantic key**: one number per situation (aiming, rolling, falling, ...)
and one script per number. `sub_kirbyanim_start $87:804C` starts a thread
from a 6-byte descriptor (object, variable, table):

    $87:9AD8  player 1: object 0, state `$7E:D7D4`, table `$87:9ADE`
    $87:B98A  player 2: object 1, state `$7E:D7D6`, table `$87:B990`
    $87:D7F7  object 10, state `$7E:D7DE`, one script

Opcodes (operand bytes after the opcode byte; w = word, b = byte):

    00 blk.w frm.b wait.b   upload blk, show frm, wait
    02 addr.w               jump
    04 var.w n.w tbl.w[n]   jump tbl[*var]
    06 addr.w               call native code in bank $87
    08 addr.w val.w         *addr = val
    0A blk.w                upload            0C frm.b   show
    0E wait.b               wait              10 blk.w frm.b
    12 blk.w wait.b                           14 frm.b wait.b
    16/18/1A                show the pose a native call computed: block
                            in $DA ($FFFF none), frame $DC ($FF none),
                            wait $DE
    1C src.w idx.b n.b      palette: n bytes $98:src -> CGRAM colour idx
    1E blk.w src.w idx.b n.b                  20 src.w idx.b n.b wait.b
    22 addr.w / 24          set / clear the per-frame native hook
    26 var.w n.w tbl.w[n]   upload tbl[*var]
    28 var.w n.w wait.b tbl.w[n]   upload tbl[*var], wait
    2A var.w n.w tbl.b[n]   show tbl[*var]
    2C dst.w var.w n.w tbl.w[n]    *dst = tbl[*var]
    2E addr.w               call script       30 var.w n.w tbl.w[n]  call tbl[*var]
    32                      return
    34/36 addr.w            ++ / -- *addr     38/3A addr.w wait.b   the same, then wait
    3C/3E/40/42/44 addr.w val.w   and / or / eor / add / sub into *addr
    46 addr.w               wait *addr frames 48 var.w n.w tbl.b[n]  wait tbl[*var]
    4A var.w n.w tbl[n] of (src.w idx.b n.b)  palette tbl[*var]
    4C var.w n.w wait.b tbl[n] of 4 bytes     the same, then wait
    4E sfx.b    50 song.b   52 halt   54 n.b loop   56 loop end   58 end

A switch on a variable is where the variation lives: Kirby's facing is a
variable the scripts index with, so "Kirby at various angles" is one script
whose switch arms are the angles. This tool decodes every script reachable
from the 51 states, writes a listing, and renders each state as a strip:
every arm of every switch is followed (up to `--arms`), and a computed pose
(16/18/1A) is marked, since its frame is chosen by native code at run time.

Rendering starts from a real hole: the OBJ page and CGRAM of a tools/snesstep
snapshot (default build/emu/kirbybase/f002300, made by `--make-base`), with
Kirby's own uploads replayed on top, blocks read in bank `$87`.

    python3 tools/kirbyanim.py --make-base     # take the base snapshot
    python3 tools/kirbyanim.py                 # -> build/sprites/kirby/
    python3 tools/kirbyanim.py --state 6       # print one state's script
    python3 tools/kirbyanim.py --live          # the same, from the game running

`--live` plays hole 1 and the 20 DEMOPLAY SELECT demos in tools/snesstep,
snapshots every other frame, and for each snapshot reads player 1's state
(`$7E:D7D4`), the facing variables (`$7E:D7C4`, 8 directions; `$7E:D7CC`
and `$7E:D75E`, 16) and Kirby's frame, drawn with the post-NMI VRAM and
CGRAM. It writes `live_state_NN.png` (frames in the order first seen) and
`live.json` (state -> frames with facing, demo and sightings). This is
ground truth for the states the runs reach; the static strips cover the
rest and show the scripted order.

`--clips` writes one reusable clip per state and switch arm to
`OUT/clips/`: `NAME.gif` (3x, transparent, a shared origin per state),
`NAME.png` (1x strip), `frames/*.png` (each picture cropped, with its
offset from the origin in the index), `clips.json` (switch values and
their meaning, per-frame durations in 60 Hz frames from the wait operands,
loop or once, source) and `clips_index.png`. Clips the replay cannot draw
(a tile it did not upload, or the curl, which object type 26 draws) are
captured from the game running instead; `--no-live` skips that. The
state names, setters and evidence are the `STATES` table below; the
format is in docs/animation.md, "Kirby animation clips".

    python3 tools/kirbyanim.py --clips         # -> build/sprites/kirby/clips/
"""

import argparse
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import frametabs  # noqa: E402
import objsheets  # noqa: E402
import sprites  # noqa: E402
import vram  # noqa: E402
from lorom import fmt_snes, snes_to_file  # noqa: E402
from romcheck import RomError, load_rom  # noqa: E402
from tiles import snes_color  # noqa: E402

BANK = 0x87
FRAME_BANK = 0x89
PLAYERS = {1: (0x9AD8, 0x9295), 2: (0xB98A, 0x92F3)}   # descriptor, frame table
INDEX_VARS = {1: 0xD95E, 2: 0xD960}     # per-player frame index copies (Player)
PALETTE_BANK = 0x98
BASE = "build/emu/kirbybase/f002300"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# opcode -> (mnemonic, operand layout). Layout letters: w word, b byte,
# T switch (var.w n.w tbl.w[n]), B byte switch (var.w n.w tbl.b[n]),
# W waiting switch (var.w n.w wait.b tbl.w[n]), D store switch
# (dst.w var.w n.w tbl.w[n]), P palette switch (var.w n.w tbl[n] x 4 bytes),
# Q waiting palette switch (var.w n.w wait.b tbl[n] x 4).
OPS = {
    0x00: ("upload_show_wait", "wbb"), 0x02: ("jump", "w"), 0x04: ("switch", "T"),
    0x06: ("native", "w"), 0x08: ("store", "ww"), 0x0A: ("upload", "w"),
    0x0C: ("show", "b"), 0x0E: ("wait", "b"), 0x10: ("upload_show", "wb"),
    0x12: ("upload_wait", "wb"), 0x14: ("show_wait", "bb"),
    0x16: ("show_computed", ""), 0x18: ("show_computed", ""),
    0x1A: ("show_computed", ""), 0x1C: ("palette", "wbb"),
    0x1E: ("upload_palette", "wwbb"), 0x20: ("palette_wait", "wbbb"),
    0x22: ("hook", "w"), 0x24: ("unhook", ""), 0x26: ("upload_switch", "T"),
    0x28: ("upload_switch_wait", "W"), 0x2A: ("show_switch", "B"),
    0x2C: ("store_switch", "D"), 0x2E: ("call", "w"), 0x30: ("call_switch", "T"),
    0x32: ("return", ""), 0x34: ("inc", "w"), 0x36: ("dec", "w"),
    0x38: ("inc_wait", "wb"), 0x3A: ("dec_wait", "wb"), 0x3C: ("and", "ww"),
    0x3E: ("or", "ww"), 0x40: ("eor", "ww"), 0x42: ("add", "ww"),
    0x44: ("sub", "ww"), 0x46: ("wait_var", "w"), 0x48: ("wait_switch", "B"),
    0x4A: ("palette_switch", "P"), 0x4C: ("palette_switch_wait", "Q"),
    0x4E: ("sfx", "b"), 0x50: ("song", "b"), 0x52: ("halt", ""),
    0x54: ("loop", "b"), 0x56: ("loop_end", ""), 0x58: ("end", ""),
}
ARITH = {"inc": lambda x, _: x + 1, "dec": lambda x, _: x - 1,
         "inc_wait": lambda x, _: x + 1, "dec_wait": lambda x, _: x - 1,
         "and": lambda x, v: x & v, "or": lambda x, v: x | v, "eor": lambda x, v: x ^ v,
         "add": lambda x, v: x + v, "sub": lambda x, v: x - v}
TERMINAL = {"jump", "switch", "return", "halt", "end", "call_switch"}
YIELDS = {"upload_show_wait", "wait", "upload_wait", "show_wait", "show_computed",
          "palette_wait", "upload_switch_wait", "inc_wait", "dec_wait",
          "wait_var", "wait_switch", "palette_switch_wait"}


class Rom(object):
    def __init__(self, data):
        self.d = data

    def b(self, addr):
        return self.d[snes_to_file(BANK, addr & 0xFFFF)]

    def w(self, addr):
        return self.b(addr) | (self.b(addr + 1) << 8)


def decode(rom, pc):
    """One instruction at pc: (op dict, next pc)."""
    code = rom.b(pc)
    if code not in OPS:
        return {"pc": pc, "op": "bad", "code": code}, None
    name, layout = OPS[code]
    p = pc + 1
    ins = {"pc": pc, "op": name, "code": code}
    args = []
    if layout in ("T", "B", "W", "D", "P", "Q"):
        if layout == "D":
            ins["dst"] = rom.w(p)
            p += 2
        ins["var"] = rom.w(p)
        n = rom.w(p + 2)
        ins["n"] = n
        p += 4
        if layout in ("W", "Q"):
            ins["wait"] = rom.b(p)
            p += 1
        if layout == "B":
            ins["table"] = [rom.b(p + i) for i in range(n)]
            p += n
        elif layout in ("P", "Q"):
            ins["table"] = [(rom.w(p + 4 * i), rom.b(p + 4 * i + 2),
                             rom.b(p + 4 * i + 3)) for i in range(n)]
            p += 4 * n
        else:
            ins["table"] = [rom.w(p + 2 * i) for i in range(n)]
            p += 2 * n
    else:
        for c in layout:
            if c == "w":
                args.append(rom.w(p))
                p += 2
            else:
                args.append(rom.b(p))
                p += 1
        ins["args"] = args
    return ins, p


def listing(rom, entry, limit=400):
    """Every instruction reachable from entry, by address."""
    seen, work = {}, [entry]
    while work and len(seen) < limit:
        pc = work.pop()
        while pc not in seen and len(seen) < limit:
            ins, nxt = decode(rom, pc)
            seen[pc] = ins
            op = ins["op"]
            if op == "bad":
                break
            if op in ("jump", "call"):
                work.append(ins["args"][0])
            if op in ("switch", "call_switch"):
                work.extend(ins["table"])
            if op in TERMINAL and op not in ("call_switch",):
                break
            pc = nxt
    return [seen[k] for k in sorted(seen)]


def fmt_ins(ins):
    op = ins["op"]
    if op == "bad":
        return "?? ${:02X}".format(ins["code"])
    if "table" in ins:
        head = "{} *$7E:{:04X}".format(op, ins["var"])
        if "dst" in ins:
            head = "{} $7E:{:04X} = ".format(op, ins["dst"]) + head[len(op) + 1:]
        if "wait" in ins:
            head += " wait {}".format(ins["wait"])
        tbl = ins["table"]
        if op in ("switch", "call_switch"):
            items = ["$87:{:04X}".format(t) for t in tbl]
        elif op in ("upload_switch", "upload_switch_wait", "store_switch"):
            items = ["${:04X}".format(t) for t in tbl]
        elif op in ("palette_switch", "palette_switch_wait"):
            items = ["$98:{:04X}>{}+{}".format(*t) for t in tbl]
        else:
            items = [str(t) for t in tbl]
        return "{} [{}]".format(head, ", ".join(items))
    a = ins.get("args", [])
    if op in ("jump", "call", "native", "hook"):
        return "{} $87:{:04X}".format(op, a[0])
    if op in ("store", "and", "or", "eor", "add", "sub"):
        return "{} $7E:{:04X}, ${:04X}".format(op, a[0], a[1])
    if op in ("inc", "dec", "wait_var"):
        return "{} $7E:{:04X}".format(op, a[0])
    if op in ("inc_wait", "dec_wait"):
        return "{} $7E:{:04X} wait {}".format(op, a[0], a[1])
    if op == "upload_show_wait":
        return "upload $87:{:04X}, show {}, wait {}".format(*a)
    if op == "upload_show":
        return "upload $87:{:04X}, show {}".format(*a)
    if op == "upload_wait":
        return "upload $87:{:04X}, wait {}".format(*a)
    if op == "upload":
        return "upload $87:{:04X}".format(*a)
    if op == "show_wait":
        return "show {}, wait {}".format(*a)
    if op in ("palette", "palette_wait", "upload_palette"):
        return "{} {}".format(op, " ".join("${:X}".format(x) for x in a))
    return "{} {}".format(op, " ".join(str(x) for x in a)).strip()


class KFrame(objsheets.Frame):
    """A Frame that also records which of its tiles came from the base page."""

    __slots__ = ("base_tiles",)


class Player(object):
    """Replays a script against a tile page, following one arm per switch.

    `index_var` is the player's frame-index copy (`$7E:D95E` for player 1,
    `$7E:D960` for player 2): `$82:F0F8` copies it to the drawing slot's
    `$0B7E` every frame while the ball is in play, so a script's store to
    it is a show. A store to `state_var` is a state change: the thread
    jumps to the new state's script on the next frame, so the replay stops
    there (`next_state`). `written` collects the OBJ tiles the replay has
    uploaded; a frame drawing any other tile shows whatever the base
    snapshot had there (`Frame.base_tiles`).
    """

    def __init__(self, rom, page, cgram, table, index_var=0xD95E, state_var=0xD7D4,
                 ram=None):
        self.rom = rom
        self.page = bytearray(page)
        self.cgram = bytearray(cgram)
        self.table = table
        self.index_var = index_var
        self.state_var = state_var
        self.frames = []
        self.notes = []
        self.written = set()
        self.cur = 0
        self.next_state = None
        self.loop_start = None
        # WRAM words the scripts switch on or do arithmetic on. A variable
        # not given here takes `choose(ins)` the first time a switch reads it.
        self.ram = dict(ram or {})

    def upload(self, blk):
        if not vram.clean_block(self.rom.d, BANK, blk):
            self.notes.append("bad block ${:04X}".format(blk))
            return
        for rec in vram.parse_block(self.rom.d, BANK, blk):
            first, last = vram.tile_range(rec["vram_word"], rec["size"])
            kind, kb, ka = vram.source_of(rec)
            if first is None or kind != "rom" or rec["slot"] != vram.MODE_COPY:
                continue
            off = snes_to_file(kb, ka)
            start = (rec["vram_word"] - vram.NAME_BASE) * 2
            n = min(rec["size"], len(self.page) - start)
            self.page[start:start + n] = self.rom.d[off:off + n]
            self.written.update(range(start // 32, (start + n + 31) // 32))

    def palette(self, src, idx, n):
        off = snes_to_file(PALETTE_BANK, src)
        self.cgram[2 * idx:2 * idx + n] = self.rom.d[off:off + n]

    def show(self, index, wait, how):
        off = snes_to_file(FRAME_BANK, self.table + 2 * index)
        word = self.rom.d[off] | (self.rom.d[off + 1] << 8)
        if word in (0, 0xFFFF) or not frametabs.frame_ok(self.rom.d, FRAME_BANK, word):
            self.notes.append("index {} has no frame".format(index))
            return
        parts = objsheets.frame_parts(self.rom.d, word)
        f = KFrame()
        f.addr, f.parts, f.table, f.index = word, parts, self.table, index
        f.duration, f.site, f.flags = max(1, wait), None, [how]
        f.tiles = {t: bytes(self.page[t * 32:t * 32 + 32])
                   for t in objsheets.tiles_of(parts)}
        f.palettes = [[snes_color(self.cgram[0x100 + p * 32 + 2 * i] |
                                  (self.cgram[0x100 + p * 32 + 2 * i + 1] << 8))
                       for i in range(16)] for p in range(8)]
        f.base_tiles = sorted(t for t in f.tiles if t not in self.written)
        self.frames.append(f)

    def run(self, entry, choose, max_steps=300, max_frames=48):
        """Run from entry; `choose(ins)` picks a switch arm. Returns why it stopped.

        "loops" means the script came back to a point it had already
        yielded at, in the same situation; `loop_start` is then the index
        of the frame the cycle restarts from.
        """
        # A script that never sets an index keeps the one the previous state
        # left; that is `self.cur`, 0 (Kirby's standing layout, entry 0 of
        # $89:9295) unless a prelude set it.
        pc, cur, stack, loops, seen = entry, self.cur, [], [], {}
        changed = False
        ram = self.ram

        def pick(ins):
            if ins["var"] not in ram:
                ram[ins["var"]] = choose(ins)
            return min(ram[ins["var"]], ins["n"] - 1)
        for _ in range(max_steps):
            self.cur = cur
            if len(self.frames) >= max_frames:
                return "frame cap"
            ins, nxt = decode(self.rom, pc)
            op = ins["op"]
            a = ins.get("args", [])
            if op == "bad":
                return "bad opcode ${:02X} at $87:{:04X}".format(ins["code"], pc)
            # One cycle of a looping animation is enough: stop when a yield
            # point comes round again with the same switch choices, call
            # stack and loop counters (so a counted loop runs out).
            if op in YIELDS:
                if self.next_state is not None:
                    return "next state {}".format(self.next_state)
                key = (pc, cur, tuple(stack), tuple(c for c, _ in loops),
                       tuple(sorted(ram.items())))
                if key in seen:
                    self.loop_start = seen[key]
                    return "loops"
                seen[key] = len(self.frames)
            if op == "store" and a[0] == self.state_var:
                self.next_state = a[1]
            if op == "store" and a[0] == self.index_var:
                cur = a[1]
                changed = True
            if op == "store_switch" and ins["dst"] == self.index_var:
                cur = ins["table"][pick(ins)]
                changed = True
            if op == "store":
                ram[a[0]] = a[1]
            elif op == "store_switch":
                ram[ins["dst"]] = ins["table"][pick(ins)]
            elif op in ARITH:
                ram[a[0]] = ARITH[op](ram.get(a[0], 0), a[1] if len(a) > 1 else 0) & 0xFFFF
            if op in ("upload_show_wait", "upload_show", "upload_wait", "upload",
                      "upload_palette"):
                self.upload(a[0])
            if op == "upload_palette":
                self.palette(a[1], a[2], a[3])
            if op in ("palette", "palette_wait"):
                self.palette(a[0], a[1], a[2])
            if op in ("upload_switch", "upload_switch_wait"):
                self.upload(ins["table"][pick(ins)])
            if op in ("palette_switch", "palette_switch_wait"):
                self.palette(*ins["table"][pick(ins)])
            if op in ("upload_show_wait", "upload_show"):
                cur = a[1]
            if op in ("show", "show_wait"):
                cur = a[0]
            if op == "show_switch":
                cur = ins["table"][pick(ins)]
            if op in ("upload_show_wait", "upload_show", "upload_wait", "upload",
                      "upload_palette", "upload_switch", "upload_switch_wait",
                      "show", "show_wait", "show_switch", "palette", "palette_wait",
                      "palette_switch", "palette_switch_wait"):
                changed = True
            if op in YIELDS:
                changed = False
                wait = {"upload_show_wait": lambda: a[2], "wait": lambda: a[0],
                        "upload_wait": lambda: a[1], "show_wait": lambda: a[1],
                        "palette_wait": lambda: a[3],
                        "upload_switch_wait": lambda: ins["wait"],
                        "palette_switch_wait": lambda: ins["wait"],
                        "inc_wait": lambda: a[1], "dec_wait": lambda: a[1],
                        "wait_switch": lambda: ins["table"][pick(ins)],
                        "wait_var": lambda: ram.get(a[0], 4)}.get(op, lambda: 4)()
                if op == "wait_var" and a[0] not in ram:
                    self.notes.append("wait from $7E:{:04X} assumed 4".format(a[0]))
                if op == "show_computed":
                    self.notes.append("computed pose at $87:{:04X}".format(pc))
                elif cur is not None:
                    self.show(cur, wait, "script")
            if op == "jump":
                pc = a[0]
                continue
            if op in ("switch", "call_switch"):
                target = ins["table"][pick(ins)]
                if op == "call_switch":
                    stack.append(nxt)
                pc = target
                continue
            if op == "call":
                stack.append(nxt)
                pc = a[0]
                continue
            if op == "return":
                if not stack:
                    return "return with empty stack"
                pc = stack.pop()
                continue
            if op == "loop":
                loops.append([a[0], nxt])
            if op == "loop_end" and loops:
                loops[-1][0] -= 1
                if loops[-1][0] > 0:
                    pc = loops[-1][1]
                    continue
                loops.pop()
            if op in ("halt", "end"):
                self.cur = cur
                # A pose set and then held: the script stops on it, so it is
                # the state's picture even though no wait follows (after a
                # state change, for the one frame before the next script).
                if changed and cur is not None:
                    self.show(cur, 1, "held")
                if self.next_state is not None:
                    return "next state {}".format(self.next_state)
                return op
            pc = nxt
        self.cur = cur
        return "step cap"


def states(rom, player):
    desc, table = PLAYERS[player]
    obj, var, tbl = rom.w(desc), rom.w(desc + 2), rom.w(desc + 4)
    entries = []
    for i in range(64):
        e = rom.w(tbl + 2 * i)
        if e < 0x8000:
            break
        entries.append(e)
    return {"object": obj // 2, "var": var, "table_addr": tbl,
            "frame_table": table, "entries": entries}


def switch_paths(rom, entry, arms):
    """Choice lists to explore: arm k of the first switch met, for each k."""
    first = None
    for ins in listing(rom, entry):
        if "table" in ins and ins["op"] in ("switch", "call_switch", "show_switch",
                                            "upload_switch", "upload_switch_wait"):
            first = ins
            break
    if first is None:
        return [None], None
    return list(range(min(arms, first["n"]))), first


# What each state is: who sets it (the writers of $7E:D7D4 logged with
# `snesstep --watch-write`, and the `STA $D7D4,X` sites in the ROM), where it
# was seen, and what it showed. `seen` is how the pictures were obtained:
#   "play"    the game reached it on its own in a recorded run (the run and
#             frame are in the evidence);
#   "forced"  no run reached it; the state was poked into $7E:D7D4 at
#             $82:C851 (the start of a roll, hole 1) or $81:A807 (aiming)
#             and the game's interpreter ran it -- the pictures are the
#             game's, the situation is not;
#   "script"  never shown at all; described from the script only.
# Runs: "full game" = build/emu/autoplay/game (135,000 frames); "hole1long"
# = hole 1 with A pressed every 60 frames from 3500; "2P" = inputs/
# two_player.txt plus A presses; dNN = DEMOPLAY demo NN. The names are
# interpretations of those pictures and of the setting code.
STATES = {
    0: ("hold: no script", None, "play",
        "script $87:9B44 is a bare halt, so the pose is whatever was last "
        "shown; set by $80:C4CE as each hole starts (63 times in the full game)"),
    1: ("holed out: no script", None, "play",
        "same script as 0; set by $82:AEDB/$82:B041 when the ball is holed "
        "(64 times in the full game, from 13 or 14)"),
    2: ("hold the pose a script left", None, "play",
        "same script as 0; stored by the scripts of 8, 20 and by $85:B4D2 "
        "(parasol); stone alternates 20/2 every frame (d10 2066-2096)"),
    3: ("hold for native code", None, "play",
        "same script as 0; set by $82:DA4D when a copy ability is taken (d10 "
        "2065, just before the ability's state; Spark has no state of its own "
        "and stays here, d16 2202), by $82:E221 when health runs out "
        "(hole1long 7195), $87:9239, $87:E8D8"),
    4: ("aim, standing still", "aim", "play",
        "set every frame by $81:A804 while aiming with no d-pad/L/R held; "
        "switch on the facing $7E:D7C4"),
    5: ("aim, turning", "aim_turn", "play",
        "$81:A804 while the d-pad or L/R is held ($67 & $0F00, $6B & $30); "
        "alternates with 4 in d01-d04"),
    6: ("curl into the ball at the shot", "curl_into_ball", "play",
        "$81:BEF1 at the shot (hole 1 frame 2823); switch on the shot angle "
        "$7E:D7CC; drawn by object type 26 while it runs"),
    7: ("unroll after the ball stops", "unroll", "play",
        "$81:C08F when the ball comes to rest (d00 frame 1876, d05 2912): "
        "squash, Kirby unrolls, stands; then 4"),
    8: ("copy ability gained", "ability_gained", "play",
        "$82:D9E9 on swallowing an enemy (demos 10-19); switch on the "
        "ability $7E:D85A; flashes and the ability's first pose; ends in 2"),
    9: ("stand and wait for the next turn", "wait_turn", "play",
        "$80:C756 at the end of a shot, dropping the copy ability unless "
        "$80:DEFD keeps it; 2P run frame 2744 (player 1, seen from behind, "
        "waits while player 2 shoots), held 183+ frames; switch on the facing "
        "$7E:D7C4"),
    10: ("fall asleep", "fall_asleep", "forced",
         "$80:C7E6 at the end of a shot when health $7E:D7F0 is 0 and $6932 "
         "is 0; not reached in play; forced: eyes closed, slow breathing "
         "48/8/64/8 frames, sfx 51 three times"),
    11: ("tired, panting (low health)", "tired", "play",
         "$80:C7AE at the end of a shot when health $7E:D7F0 is 1 or 2; "
         "hole1long 5598 (health 2: one pant) and 6356 (health 1: four "
         "pants); switch on $7E:D7F0"),
    12: ("ball squashed on a bounce", "ball_squash", "play",
         "$81:8CA2 for 4 frames, back to 14 by $81:8CD2 (d02 2931, d07 "
         "2176); switch on $7E:6A6E"),
    13: ("hop (A pressed mid-roll)", "hop", "play",
         "$82:DAAE on each A press while rolling (hole1long 3920, 3980, ... "
         "every 60 frames, as pressed); its script returns to 14 after 17 "
         "frames; call switch on $7E:D8A6"),
    14: ("ball rolling", "ball_roll", "play",
         "$82:C84E at the start of the roll (hole 1 frame 2984) when "
         "max(|$6B54-6|, |$6B58-6|) < 3; restored by many routines"),
    15: ("ball rolling, strong spin", "ball_roll_spin_strong", "play",
         "$82:C84E when max(|$6B54-6|, |$6B58-6|) >= 4 (d06 2088 with $6B58 = "
         "0; d09 3487 with $6B54 = 0); $6B54/$6B58 are 0-12 shot settings "
         "centred on 6, taken to be the spin (unconfirmed)"),
    16: ("ball rolling, medium spin", "ball_roll_spin_medium", "forced",
         "$82:C843 when that maximum is exactly 3; not reached in play; "
         "forced: ball with spin streaks"),
    17: ("ball rolling, fast (1-frame steps)", "ball_roll_fast", "forced",
         "no writer found in the ROM; not seen in play; script: blocks "
         "$87:ABD8-$ABF3, 1 frame each"),
    18: ("ball rolling (2-frame steps)", "ball_roll_alt", "forced",
         "no writer found in the ROM; not seen in play; same blocks as 17, "
         "2 frames each"),
    19: ("ball sinking", "ball_sink", "forced",
         "$82:D87A (on the $60-$6F surface overlay: $69DA, $69D8 set, $69CA "
         "clear), $82:D936, $82:E1B0, each counting $D76C; not reached in "
         "play; forced in a roll: a dark disc rises over the ball in 4 steps "
         "of 4 frames, then 14"),
    20: ("stone", "stone", "play",
         "$82:C95B (ability 1, d10 2065), then 20/2 alternate every frame "
         "($82:D5D5 and the script's store)"),
    21: ("fireball", "fireball", "play", "$82:CA4D (d12 2233); switch on $7E:D75E"),
    22: ("needle", "needle", "play", "$82:CAF7 (d13 2109)"),
    23: ("needle (same script as 22)", "needle_alt", "script",
          "no writer found in the ROM; not seen; entry $87:A621 = 22's"),
    24: ("hi-jump: take-off", "hijump_takeoff", "play", "$82:CC80 (d17 2051)"),
    25: ("hi-jump: in the air", "hijump_air", "play", "$82:D1F8 (d17 2108)"),
    26: ("wheel: start", "wheel_start", "play", "$82:CBBC (d15 1969)"),
    27: ("wheel: rolling", "wheel_roll", "play", "$82:D09B (d15 2009)"),
    28: ("wheel: stop", "wheel_stop", "play", "$82:D127 (d15 2061)"),
    29: ("parasol: open", "parasol_open", "play", "$82:C9A1 (d11 2190)"),
    30: ("parasol: floating", "parasol_float", "play",
         "$85:B342/$85:B63F (d11 2250, 3090); also $86:A991 before hole 1 "
         "(frame 1974)"),
    31: ("parasol: other pose", "parasol_pose", "forced",
         "$85:B425 (parasol object); not reached in play; script uploads "
         "$87:B955 under the index the previous state left"),
    32: ("tornado: start", "tornado_start", "play", "$82:CB6D (d14 1991)"),
    33: ("tornado: spinning", "tornado_spin", "play",
         "$82:D72A by speed (table $82:D790), d14 2035"),
    34: ("tornado: slowing", "tornado_slow", "play", "$82:D72A, d14 2682"),
    35: ("tornado: stop, back to the ball", "tornado_stop", "forced",
         "$82:D6E3 when the tornado's speed reaches 0; not reached in play; "
         "index 13 for 20 frames, then 14"),
    36: ("freeze", "freeze", "play", "$82:CCDB (d18 2002)"),
    37: ("UFO", "ufo", "play", "$82:CD07 (d19 2125)"),
    38: ("UFO: end (empty script)", None, "script",
         "$82:D8D3 on the UFO path; the script is a bare halt"),
    39: ("UFO: wearing off", "ufo_end", "play",
         "$82:D8EA/$82:D31A/$82:D34D (d19 3000, after 37): the UFO's eyes "
         "flash, frames 41/42 every 6 frames, until $82:D90C sets 14 (d19 3087)"),
    40: ("hit: burning / electrocuted", "hit_burn", "forced",
         "$82:DC11 from the hit dispatch $82:DBDE (code $D85A - 12 in "
         "$7E:D78C: 0 = Fireball, 3 = Spark); codes come from the other "
         "player's ability via $80:DF29/$80:DF55 ($82:DB79, ball contact); not "
         "reached in play; forced: Kirby in flames (arm 3: sparks)"),
    41: ("spinning, eyes shut", "spin_dazed", "forced",
         "$82:DE8F, the shooter's side of a Fireball/Spark hit (codes 12/15 in "
         "$D9C6) once $DA4E is set; 40 frames, then 14; not reached in play"),
    42: ("hit: spun round (Tornado)", "hit_spun", "forced",
         "$82:DC31, hit code 13 (Tornado); not reached in play; forced: Kirby "
         "turns through 16 facings"),
    43: ("hit: run over (Wheel)", "hit_flattened", "forced",
         "$82:DC66, hit code 14 (Wheel); index 19-22 from $82:DCA1 by the "
         "wheel's direction; not reached in play; forced: flattened, star-eyed"),
    44: ("hit: frozen in ice (Freeze)", "hit_frozen", "forced",
         "$82:DCBF, hit code 16 (Freeze); not reached in play; forced: "
         "Kirby turns blue and an ice block closes round him"),
    45: ("thaw", "thaw", "forced",
         "$80:C898 at the end of a shot while frozen ($D85A = 16) and "
         "$82:E1DB; not reached in play; forced: ice shatters, Kirby shivers "
         "purple, pink again"),
    46: ("hit: squashed (Stone from above)", "hit_squashed", "forced",
         "$82:DD0B, hit code 17 (Stone in the air); index 20; not reached in "
         "play; forced: flattened, star-eyed"),
    47: ("red-faced", "red_faced", "forced",
         "$82:E03F, the Stone user's side after hit code 17 ($82:E00D), after a "
         "90-frame pause; the other ball is thrown up; palette $98:C7BE; not "
         "reached in play"),
    48: ("recover from red", "red_recover", "forced",
         "$82:E0BA after 47; palette fades back ($98:C7CA-$C7FA), then the "
         "native call $87:9E62 (forced run: 9 follows); not reached in play"),
    49: ("dizzy (bumped)", "dizzy", "play",
         "$82:DD73 (code 19) and $82:DDA1 (code 20, ball-to-ball bump); d08 "
         "2372: black/white flash, then spinning eyes, then 14"),
    50: ("plain ball", "ball_plain", "forced",
         "$82:DDE7, hit code 21 (from $82:A4DB); shows index 0 with block "
         "$87:AB7E; not reached in play"),
}
STATE_NAMES = {s: (v[0], "{} ({})".format(v[3], v[2])) for s, v in STATES.items()}

ABILITIES = ["none", "stone", "parasol", "fireball", "needle", "tornado", "wheel",
             "spark", "hijump", "freeze", "ufo"]

# Switch variables: (short name for file names, what the value is, degrees
# function or None). The facing and the shot angle are screen directions,
# 0 = right, counter-clockwise; estimated from the pictures (D7C4 3 faces the
# camera, 7 away, 4 down-right) and the mirror symmetry of D7CC's tables
# (arms 7 and 15 unique, k and 14-k mirrored). Unconfirmed as world angles.
SWITCH_VARS = {
    0xD7C4: ("facing", "Kirby's facing, 8 directions (ram_kirby_facing8)",
             lambda v: (135 + 45 * v) % 360),
    0xD7CC: ("angle", "the shot's angle, 16 directions (ram_kirby_shot_angle)",
             lambda v: (112.5 + 22.5 * v) % 360),
    0xD75E: ("dir", "copy-ability direction index ($82:D8A8 copies $DA04 here); "
             "degrees not established", None),
    0xD75A: ("var", "copy-ability variant / direction ($D9DE / 2 at $82:D8A2)", None),
    0xD85A: ("ability", "copy ability: " + ", ".join(
        "{} {}".format(i, a) for i, a in enumerate(ABILITIES)), None),
    0xD7F0: ("health", "Kirby's health (4 at a hole's start, -1 per shot, +1 per "
             "enemy)", None),
    0xD78C: ("hit", "hit code - 12: 0 Fireball, 1 Tornado, 2 Wheel, 3 Spark, "
             "4 Freeze (only 0 and 3 reach state 40)", None),
    0xD8A6: ("air", "0 on the ground, 1 airborne", None),
    0x6A6E: ("squash", "squash variant 0-10 (meaning unknown)", None),
    0xD8D2: ("squash", "squash variant 0-10 (meaning unknown)", None),
}
ARM_NAMES = {0xD85A: ABILITIES, 0xD8A6: ["ground", "air"],
             0xD78C: ["fireball", "tornado", "wheel", "spark", "freeze"]}

# How each state's clips are made. FIXED pins switch variables that are not
# enumerated (the rest are, as a product, if that is at most 36 clips; else
# only the first). PRELUDE runs other states first, frames discarded, for
# the tiles, palette and index they leave: a copy-ability state follows
# state 8 with its ability, and 31/35/39 follow the state that precedes
# them in play. INDEX gives the frame index the setter leaves, as a pseudo
# switch ("index").
ABILITY_OF = {20: 1, 29: 2, 30: 2, 31: 2, 21: 3, 22: 4, 23: 4, 32: 5, 33: 5, 34: 5,
              35: 5, 26: 6, 27: 6, 28: 6, 24: 8, 25: 8, 36: 9, 37: 10, 39: 10}
CLIP_FIXED = {6: {0xD8D2: 0}, 7: {0xD8D2: 0}, 9: {0x6AC0: 0},
              8: {0xD872: 0, 0xD75A: 0, 0xD75E: 0, 0xD9DE: 0}}
CLIP_PRELUDE = {31: [29, 30], 35: [32, 33], 39: [37], 34: [32, 33], 33: [32],
                25: [24], 27: [26], 28: [26, 27]}
CLIP_INDEX = {43: [19, 20, 21, 22]}
# States whose colours (or tiles) are set by native code, not their script:
# replayed on a snapshot of the demo that shows them (demo, frame), a few
# frames after the state is set.
CONTEXT_BASE = {21: (12, 2237), 36: (18, 2006), 37: (19, 2129), 39: (19, 3004)}
# Live captures for clips the static replay cannot draw (a frame shows a
# tile no replayed upload wrote). Default: force the state at the start of
# hole 1's roll ($82:C851). Some states only look right in their own
# situation: (demo, first frame, last frame) of a recorded run.
# State 6 is always taken live: during the curl script object 0 is hidden
# and object type 26 draws Kirby from its own frame list, so the script's
# frame index is not what is on screen. It is captured at hole 1's shot with
# the angle poked at the instruction that sets the state (as --live's a00-a15).
LIVE_AT_SHOT = {6: ("$81:BEF1", 2824)}

# Frame tables Kirby in the field is drawn from: player 1's and the one the
# shot stand-in (type 26) binds. `$89:9351`/`$9365` also hold Kirby art but
# are used by HUD objects (type 121 and others), so they are left out.
KIRBY_TABLES = (0x9295, 0x92F3)

# a00-a15: hole 1 again, with the shot's facing angle `$7E:D7CC` set to
# 0-15 at the instruction that enters state 6 (`$81:BEF1`). State 6's
# script reads it to choose the curl's art, and nothing writes it again
# during the curl, so each run shows the curl at one of the 16 angles.
LIVE_RUNS = ["hole1"] + ["d{:02d}".format(k) for k in range(20)] + \
    ["a{:02d}".format(k) for k in range(16)]
FACING = {"d7c4": 0xD7C4, "d7cc": 0xD7CC, "d75e": 0xD75E, "d75a": 0xD75A,
          "d8d2": 0xD8D2}


def snapshot_frame(rom, path):
    """(Frame, picture key, snapshot) for Kirby as drawn in one snapshot.

    Frame is None when nothing draws him. The picture key identifies what
    is on screen: the part list, its tiles and the palettes it uses.
    """
    import emusheets
    snap = emusheets.load_snapshot(path)
    # Whoever is drawing Kirby: script object 0 normally, but during a shot
    # it is hidden and a thread object (type 26, table $89:92F3) draws him
    # while his scripts upload the tiles.
    drawn = [(key, addr, table, index) for key, addr, table, index
             in emusheets.live_frames(rom.d, snap)
             if table in KIRBY_TABLES and addr >= 0x8000]
    if not drawn:
        return None, None, snap
    drawn.sort(key=lambda d: d[0][0] != "script")   # script object first
    key, addr, table, index = drawn[0]
    parts = objsheets.frame_parts(rom.d, addr)
    tiles = emusheets.obj_tiles(snap)
    pals = emusheets.obj_palettes(snap["cgram"])
    f = KFrame()
    f.addr, f.parts, f.table, f.index = addr, parts, table, index
    f.duration, f.site, f.flags = 1, None, ["observed", "{}{}".format(*key)]
    f.tiles = {t: tiles[t] for t in objsheets.tiles_of(parts)}
    f.palettes = pals
    f.base_tiles = []
    used = sorted(set(p["palette"] for p in parts))
    pk = (addr, tuple(sorted(f.tiles.items())), tuple(tuple(pals[p]) for p in used))
    return f, pk, snap


def live(rom, out, every=2):
    """Group Kirby's on-screen frames by animation state, from real play."""
    import shutil
    sys.path.insert(0, os.path.join(ROOT, "tools", "snesstep"))
    import demos
    binp = os.path.join(ROOT, "build", "snesstep", "release", "snesstep")
    groups = {}            # state -> {picture key: [Frame, facing set, runs, n]}
    order = {}
    for run in LIVE_RUNS:
        tmp = os.path.join(ROOT, "build", "emu", "kirbylive_" + run)
        os.makedirs(tmp, exist_ok=True)
        extra, every_here = [], every
        if run == "hole1":
            inp, start, end = os.path.join(ROOT, "tools", "snesstep", "inputs",
                                           "play_hole1.txt"), 2100, 3400
        elif run.startswith("a"):
            inp = os.path.join(ROOT, "tools", "snesstep", "inputs", "play_hole1.txt")
            start, end, every_here = 2822, 2870, 1
            extra = ["--poke-at-pc", "$81:BEF1,$7E:D7CC={:04X}".format(int(run[1:]))]
        else:
            inp = os.path.join(tmp, "input.txt")
            with open(inp, "w") as f:
                f.write(demos.script(int(run[1:])))
            start, end = 820, 2900
        step = every_here if run.startswith("a") else every
        snaps = ",".join(str(f) for f in range(start, end, step))
        subprocess.run([binp, "--frames", str(end), "--input", inp, "--snap-at", snaps,
                        "--no-dsp", "--quiet", "--out", tmp] + extra, check=True)
        for d in sorted(os.listdir(tmp)):
            if not d.startswith("f"):
                continue
            f, pk, snap = snapshot_frame(rom, os.path.join(tmp, d))
            if f is None:
                continue
            w = snap["wram"]
            w16 = lambda a: w[a] | (w[a + 1] << 8)  # noqa: E731
            state = w16(0xD7D4)
            bucket = groups.setdefault(state, {})
            facing = tuple((k, w16(a)) for k, a in sorted(FACING.items()))
            if pk not in bucket:
                bucket[pk] = [f, set(), set(), 0]
                order.setdefault(state, []).append(pk)
            bucket[pk][1].add(facing)
            bucket[pk][2].add(run)
            bucket[pk][3] += 1
        shutil.rmtree(tmp, ignore_errors=True)
        print("live: {} done".format(run), flush=True)
    report = {}
    for state, bucket in sorted(groups.items()):
        frames = [bucket[pk][0] for pk in order[state]]
        img, atlas = objsheets.sheet(frames)
        img.save(os.path.join(out, "live_state_{:02d}.png".format(state)))
        cells = []
        for cell, pk in zip(atlas["frames"], order[state]):
            f, facings, runs, n = bucket[pk]
            cell["sightings"] = n
            cell["drawn_by"] = f.flags[1]
            cell["runs"] = sorted(runs)
            cell["facing"] = sorted({k: v for k, v in fa} for fa in facings)[:6] \
                if False else [dict(fa) for fa in sorted(facings)][:6]
            cells.append(cell)
        atlas["frames"] = cells
        report[state] = atlas
    with open(os.path.join(out, "live.json"), "w") as f:
        json.dump(report, f, indent=1)
    by_facing(rom, out, report)
    print("live: {} states seen, {} pictures".format(
        len(report), sum(len(v["frames"]) for v in report.values())))


def by_facing(rom, out, report):
    """`live_state_NN_facing.png`: one row per value of the state's facing
    variable (the variable its script switches on), frames in order seen.

    A picture seen under several values appears in each of their rows; a
    round ball looks the same from every angle.
    """
    from PIL import Image
    info = states(rom, 1)
    names = {v: k for k, v in FACING.items()}
    for st, atlas in report.items():
        if st >= len(info["entries"]):
            continue
        sw = None
        for ins in listing(rom, info["entries"][st]):
            if "table" in ins and ins.get("var") in names:
                sw = names[ins["var"]]
                break
        if sw is None:
            continue
        sheet = Image.open(os.path.join(out, "live_state_{:02d}.png".format(st)))
        cw, ch = atlas["cell"]
        rows = {}
        for cell in atlas["frames"]:
            for fa in cell["facing"]:
                rows.setdefault(fa[sw], [])
                if cell not in rows[fa[sw]]:
                    rows[fa[sw]].append(cell)
        if len(rows) < 2:
            continue
        cols = max(len(v) for v in rows.values())
        img = Image.new("RGBA", (cols * cw, len(rows) * ch), (0, 0, 0, 0))
        for r, value in enumerate(sorted(rows)):
            for c, cell in enumerate(rows[value]):
                img.paste(sheet.crop((cell["x"], cell["y"], cell["x"] + cw,
                                      cell["y"] + ch)), (c * cw, r * ch))
        img.save(os.path.join(out, "live_state_{:02d}_facing.png".format(st)))
        with open(os.path.join(out, "live_state_{:02d}_facing.json".format(st)),
                  "w") as f:
            json.dump({"variable": "$7E:{:04X}".format(FACING[sw]),
                       "rows": [{"value": v, "frames": len(rows[v])}
                                for v in sorted(rows)]}, f, indent=1)


# ---------------------------------------------------------------------------
# Clips: one reusable animation per state and switch arm.

CLIP_SCALE = 3          # GIF scale (nearest neighbour)
CLIP_MAX_COMBOS = 36    # enumerate a product of switch variables up to this
LIVE_CAP = 240          # frames captured per live clip at most


def clip_axes(rom, s, entry):
    """(free variables [(var, n)], fixed {var: value}) for state s."""
    seen, phase = [], set()
    for ins in listing(rom, entry):
        if ins["op"] in ARITH:
            phase.add(ins["args"][0])
        if "table" in ins:
            for i, (v, n) in enumerate(seen):
                if v == ins["var"]:
                    seen[i] = (v, max(n, ins["n"]))
                    break
            else:
                seen.append((ins["var"], ins["n"]))
    # A variable the script itself steps (tornado's spin phase) is not an
    # arm: it starts at 0 and the clip runs through its values.
    fixed = dict(CLIP_FIXED.get(s, {}))
    for v, _ in seen:
        if v in phase and v not in fixed:
            fixed[v] = 0
    free = [(v, n) for v, n in seen if v not in fixed]
    if s in CLIP_INDEX:
        free = [("index", len(CLIP_INDEX[s]))] + free
    total = 1
    for _, n in free:
        total *= n
    if total > CLIP_MAX_COMBOS:
        free = free[:1]
    return free, fixed


def arm_label(var, n, value, s):
    if var == "index":
        return "index{}".format(CLIP_INDEX[s][value])
    if var in ARM_NAMES:
        return ARM_NAMES[var][value]
    short = SWITCH_VARS.get(var, ("v{:04X}".format(var),))[0]
    return "{}{:0{}d}".format(short, value, 2 if n > 10 else 1)


def arm_info(var, n, value, s):
    if var == "index":
        return {"var": "setter index", "value": CLIP_INDEX[s][value],
                "meaning": "frame index the setting code leaves in $0B7E"}
    short, meaning, deg = SWITCH_VARS.get(var, ("v{:04X}".format(var), "unknown", None))
    d = {"var": "$7E:{:04X}".format(var), "name": short, "value": value, "arms": n,
         "meaning": meaning}
    if var in ARM_NAMES:
        d["arm_name"] = ARM_NAMES[var][value]
    if deg is not None:
        d["degrees"] = deg(value)
        d["degrees_note"] = "screen direction, 0 = right, counter-clockwise; estimated"
    return d


def merge_runs(frames, loop_start=None):
    """Consecutive identical pictures -> one frame with the summed duration."""
    out, remap = [], {}
    for i, f in enumerate(frames):
        if out and out[-1].key() == f.key():
            out[-1].duration += f.duration
        else:
            out.append(f)
        remap[i] = len(out) - 1
    if loop_start is not None:
        loop_start = remap.get(loop_start, 0)
        # The loop may restart on a picture merged into the previous one.
    return out, loop_start


def context_base(s):
    """Path of the in-play snapshot state s is replayed on, made if missing."""
    k, frame = CONTEXT_BASE[s]
    path = os.path.join(ROOT, "build", "emu", "kirbyclip_bases", "d{:02d}".format(k))
    snap = os.path.join(path, "f{:06d}".format(frame))
    if not os.path.isdir(snap):
        sys.path.insert(0, os.path.join(ROOT, "tools", "snesstep"))
        import demos
        os.makedirs(path, exist_ok=True)
        inp = os.path.join(path, "input_{}.txt".format(frame))
        with open(inp, "w") as f:
            f.write(demos.script(k))
        subprocess.run([os.path.join(ROOT, "build", "snesstep", "release", "snesstep"),
                        "--frames", str(frame + 1), "--input", inp, "--snap-at",
                        str(frame), "--no-dsp", "--quiet", "--out", path], check=True)
    return snap


def replay_clip(rom, info, page, cgram, s, env, index0):
    """Static replay of state s with switch values env: (Player, why, prelude)."""
    entries = info["entries"]
    allenv = {0xD85A: ABILITY_OF.get(s, 0)}
    allenv.update(env)
    prelude = ([8] if s in ABILITY_OF else []) + CLIP_PRELUDE.get(s, [])
    if s in CONTEXT_BASE:
        page, cgram = load_base(context_base(s))
        prelude = []
    p = Player(rom, page, cgram, info["frame_table"], ram=allenv)
    if s in CONTEXT_BASE:
        p.written = set(range(len(page) // 32))     # the real situation's tiles
    for pre in prelude:
        p.run(entries[pre], lambda ins: 0, max_steps=3000, max_frames=400)
        p.frames, p.next_state, p.loop_start, p.notes = [], None, None, []
        p.ram.update(env)
    if index0 is not None:
        p.cur = index0
    why = p.run(entries[s], lambda ins: 0, max_steps=4000, max_frames=240)
    return p, why, prelude


def clip_input(path):
    """Hole 1 without the A press at 3020, so the roll from 2984 to 3401
    has no state write of its own: the forced state runs undisturbed."""
    src = os.path.join(ROOT, "tools", "snesstep", "inputs", "play_hole1.txt")
    with open(src) as f:
        lines = [ln for ln in f if not ln.startswith("3020 ")]
    with open(path, "w") as f:
        f.writelines(lines)


def capture_live(rom, s, env, index0, nframes, tmp):
    """Kirby's pictures, frame by frame, with state s running in the game.

    Returns (frames merged with exact durations, description, next state).
    """
    import shutil
    binp = os.path.join(ROOT, "build", "snesstep", "release", "snesstep")
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp)
    extra = []
    if s in LIVE_AT_SHOT:
        pc, start = LIVE_AT_SHOT[s]
        inp = os.path.join(ROOT, "tools", "snesstep", "inputs", "play_hole1.txt")
        end = start + min(nframes + 4, LIVE_CAP)
        pokes = ["$7E:{:04X}={:04X}".format(v, x) for v, x in sorted(env.items())]
        for pk in pokes:
            extra += ["--poke-at-pc", pc + "," + pk]
        desc = "hole 1, at the shot ({}: {}), frames {}-{}".format(
            pc, ", ".join(pokes), start, end - 1)
    else:
        inp = os.path.join(tmp, "input.txt")
        clip_input(inp)
        start = 2985
        end = start + 1 + min(nframes + 2, LIVE_CAP)
        pokes = ["$7E:D7D4={:04X}".format(s)]
        pokes += ["$7E:{:04X}={:04X}".format(v, x) for v, x in sorted(env.items())
                  if v != "index"]
        if index0 is not None:
            pokes.append("$7E:D95E={:04X}".format(index0))
        for pk in pokes:
            extra += ["--poke-at-pc", "$82:C851," + pk]
        desc = "hole 1, forced at the start of the roll ($82:C851: {}), frames " \
               "{}-{}".format(", ".join(pokes), start + 1, end - 1)
    subprocess.run([binp, "--frames", str(end + 1), "--input", inp, "--snap-at",
                    ",".join(str(x) for x in range(start, end)), "--no-dsp", "--quiet",
                    "--out", tmp] + extra, check=True)
    frames, nxt = [], None
    dirs = sorted(d for d in os.listdir(tmp) if d.startswith("f"))
    if s not in LIVE_AT_SHOT:
        dirs = dirs[1:]      # the frame the state was set still shows the roll
    for d in dirs:
        f, pk, snap = snapshot_frame(rom, os.path.join(tmp, d))
        w = snap["wram"]
        st = w[0xD7D4] | (w[0xD7D5] << 8)
        if st != s:
            nxt = st
            break
        if f is None:
            continue
        frames.append(f)
    shutil.rmtree(tmp, ignore_errors=True)
    frames, _ = merge_runs(frames)
    return frames, desc, nxt


def gif_write(images, durations, path, loop):
    """Animated GIF with a transparent background; durations in 60 Hz frames."""
    from PIL import Image
    colours = {}
    for im in images:
        for c, a in ((px[:3], px[3]) for px in im.getdata()):
            if a and c not in colours:
                colours[c] = len(colours) + 1
    if len(colours) > 255:
        raise ValueError("too many colours for a GIF")
    pal = [0, 0, 0]
    for c in sorted(colours, key=colours.get):
        pal.extend(c)
    pal += [0] * (768 - len(pal))
    frames = []
    for im in images:
        p = Image.new("P", im.size, 0)
        p.putpalette(pal)
        p.putdata([colours[px[:3]] if px[3] else 0 for px in im.getdata()])
        frames.append(p)
    # GIF delays are in 1/100 s: 60 Hz frames rounded, at least 2.
    ms = [max(20, int(round(d * 100 / 60.0)) * 10) for d in durations]
    kw = {"loop": 0} if loop else {}
    frames[0].save(path, save_all=True, append_images=frames[1:], duration=ms,
                   transparency=0, disposal=2, optimize=False, **kw)


def clips(rom, out, base, live_ok=True):
    """Every state x switch arm -> GIF, strip, frame PNGs and clips.json."""
    import hashlib
    from PIL import Image, ImageDraw
    resample = getattr(Image, "Resampling", Image).NEAREST
    info = states(rom, 1)
    page, cgram = load_base(base)
    cdir = os.path.join(out, "clips")
    fdir = os.path.join(cdir, "frames")
    os.makedirs(fdir, exist_ok=True)
    tmp = os.path.join(ROOT, "build", "emu", "kirbyclip_tmp")
    index, skipped, by_state = [], [], {}
    for s, entry in enumerate(info["entries"]):
        name, slug, seen, evidence = STATES[s]
        if slug is None:
            skipped.append({"state": s, "name": name, "why": evidence})
            continue
        free, fixed = clip_axes(rom, s, entry)
        combos = [()]
        for _, n in free:
            combos = [c + (v,) for c in combos for v in range(n)]
        for combo in combos:
            env, index0 = dict(fixed), None
            for (var, n), v in zip(free, combo):
                if var == "index":
                    index0 = CLIP_INDEX[s][v]
                else:
                    env[var] = v
            p, why, prelude = replay_clip(rom, info, page, cgram, s, env, index0)
            frames, loop_start = merge_runs(p.frames, p.loop_start)
            label = "_".join(arm_label(var, n, v, s) for (var, n), v in zip(free, combo))
            clip = {"name": slug + ("_" + label if label else ""), "state": s,
                    "state_name": name, "seen": seen,
                    "script": "$87:{:04X}".format(entry),
                    "switches": [arm_info(var, n, v, s) for (var, n), v
                                 in zip(free, combo)],
                    "fixed": {"$7E:{:04X}".format(k): v for k, v in sorted(fixed.items())},
                    "prelude": prelude, "stop": why,
                    "loop": why == "loops", "loop_start": loop_start if why == "loops"
                    else None,
                    "next_state": p.next_state, "source": "script",
                    "notes": sorted(set(p.notes))}
            bad = sum(1 for f in frames if getattr(f, "base_tiles", None))
            clip["static_frames_with_base_tiles"] = bad
            if (bad or not frames or s in LIVE_AT_SHOT) and live_ok:
                total = sum(f.duration for f in frames) or 120
                lf, desc, nxt = capture_live(rom, s, env, index0, total, tmp)
                if lf:
                    clip["source"] = "live"
                    clip["live"] = desc
                    clip["live_next_state"] = nxt
                    clip["why_live"] = (
                        "drawn by object type 26, not the script's frame index"
                        if s in LIVE_AT_SHOT else
                        "{} of {} frames of the static replay draw tiles no replayed "
                        "upload wrote (they would show the base snapshot's)".format(
                            bad, len(frames)) if frames else
                        "the static replay shows nothing")
                    frames = lf
                    if clip["loop_start"] is not None:
                        clip["loop_start"] = 0
                        clip["loop_note"] = ("live window: about one pass of the "
                                             "script, may cut a cycle short")
            if not frames:
                clip["frames"] = []
                skipped.append({"state": s, "name": clip["name"],
                                "why": "no frame shown ({})".format(why)})
                continue
            clip["_frames"] = frames
            index.append(clip)
            by_state.setdefault(s, []).append(clip)
        print("clips: state {:2d} {} ({})".format(s, slug, len(combos)), flush=True)

    sigs = {}
    for s, group in sorted(by_state.items()):
        box = objsheets.union_box([f for c in group for f in c["_frames"]])
        cw, ch = box[2] - box[0], box[3] - box[1]
        for c in group:
            frames = c.pop("_frames")
            cells, images = [], []
            for f in frames:
                fb = sprites.frame_bbox(f.parts)
                img = objsheets.draw(f.parts, f.tiles, f.palettes, fb)
                h = hashlib.sha1(img.tobytes() + repr(img.size).encode()).hexdigest()[:12]
                fname = "frames/{}.png".format(h)
                if not os.path.exists(os.path.join(cdir, fname)):
                    img.save(os.path.join(cdir, fname))
                cells.append({"png": fname, "duration": f.duration,
                              "x": fb[0], "y": fb[1], "w": fb[2] - fb[0],
                              "h": fb[3] - fb[1], "list": fmt_snes(FRAME_BANK, f.addr),
                              "index": f.index})
                images.append(objsheets.draw(f.parts, f.tiles, f.palettes, box))
            strip = Image.new("RGBA", (cw * len(images), ch), (0, 0, 0, 0))
            for i, im in enumerate(images):
                strip.paste(im, (i * cw, 0))
            strip.save(os.path.join(cdir, c["name"] + ".png"))
            big = [im.resize((cw * CLIP_SCALE, ch * CLIP_SCALE), resample) for im in images]
            gif_write(big, [f.duration for f in frames],
                      os.path.join(cdir, c["name"] + ".gif"), c["loop"])
            c["gif"] = c["name"] + ".gif"
            c["gif_scale"] = CLIP_SCALE
            c["strip"] = c["name"] + ".png"
            c["cell"] = [cw, ch]
            c["origin"] = [-box[0], -box[1]]
            c["frames"] = cells
            c["total_frames"] = sum(x["duration"] for x in cells)
            sig = tuple((x["png"], x["duration"]) for x in cells)
            if sig in sigs:
                c["same_as"] = sigs[sig]
            else:
                sigs[sig] = c["name"]

    doc = {
        "about": "Kirby's animation clips: one per animation state ($7E:D7D4, "
                 "script table $87:9ADE) and switch arm. Durations are in "
                 "frames at 60 Hz, from the scripts' wait operands (source "
                 "'script') or counted frame by frame in the emulator (source "
                 "'live'). Frame PNGs are cropped to the frame; x/y is their "
                 "top-left relative to the sprite origin (the object's "
                 "position). Strips use one cell size per state, origin at "
                 "'origin' within the cell; GIFs are the strip cells scaled "
                 "by gif_scale. A clip with loop true repeats from frame "
                 "loop_start; otherwise it plays once and holds the last frame "
                 "(or hands over to next_state). GIF delays are rounded to "
                 "1/100 s.",
        "states": {str(s): {"name": v[0], "slug": v[1], "seen": v[2], "evidence": v[3]}
                   for s, v in sorted(STATES.items())},
        "clips": index, "no_clip": skipped}
    with open(os.path.join(cdir, "clips.json"), "w") as f:
        json.dump(doc, f, indent=1)
    contact_sheet(cdir, index)
    print("clips: {} clips ({} from live play), {} states without one; wrote {}".format(
        len(index), sum(1 for c in index if c["source"] == "live"), len(skipped), cdir))


def contact_sheet(cdir, index, cols=12, scale=2):
    """clips_index.png: the first frame of every clip with its name."""
    from PIL import Image, ImageDraw
    resample = getattr(Image, "Resampling", Image).NEAREST
    cell_w, img_h, text_h = 112, 80, 22
    rows = (len(index) + cols - 1) // cols
    sheet = Image.new("RGBA", (cols * cell_w, rows * (img_h + text_h)), (40, 44, 52, 255))
    d = ImageDraw.Draw(sheet)
    for n, c in enumerate(index):
        x, y = (n % cols) * cell_w, (n // cols) * (img_h + text_h)
        strip = Image.open(os.path.join(cdir, c["strip"]))
        cw, ch = c["cell"]
        im = strip.crop((0, 0, cw, ch))
        k = min(scale, max(1, min((cell_w - 4) // cw, img_h // ch)))
        im = im.resize((cw * k, ch * k), resample)
        sheet.paste(im, (x + (cell_w - im.width) // 2, y + (img_h - im.height) // 2), im)
        title = "{} {}{}".format(c["state"], "L " if c["source"] == "live" else "",
                                 "{}f{}".format(len(c["frames"]), " loop" if c["loop"] else ""))
        d.text((x + 2, y + img_h), title, fill=(255, 220, 120))
        d.text((x + 2, y + img_h + 10), c["name"][-18:], fill=(220, 220, 220))
    sheet.save(os.path.join(cdir, "clips_index.png"))


def make_base():
    out = os.path.join(ROOT, "build", "emu", "kirbybase")
    subprocess.run([os.path.join(ROOT, "build", "snesstep", "release", "snesstep"),
                    "--frames", "2400", "--input",
                    os.path.join(ROOT, "tools", "snesstep", "inputs", "play_hole1.txt"),
                    "--snap-at", "2300", "--no-dsp", "--quiet", "--out", out],
                   check=True)


def load_base(path):
    def raw(name):
        post = os.path.join(path, name.replace(".bin", "_post.bin"))
        with open(post if os.path.exists(post) else os.path.join(path, name), "rb") as f:
            return f.read()
    v = raw("vram.bin")
    return v[0xC000:0x10000], raw("cgram.bin")      # OBJ page at word $6000


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="build/sprites/kirby")
    ap.add_argument("--player", type=int, default=1, choices=(1, 2))
    ap.add_argument("--state", type=int, help="print one state's script")
    ap.add_argument("--base", default=BASE, help="snapshot giving page and palette")
    ap.add_argument("--arms", type=int, default=16, help="switch arms rendered per state")
    ap.add_argument("--make-base", action="store_true")
    ap.add_argument("--live", action="store_true",
                    help="group real on-screen frames by state (runs the game)")
    ap.add_argument("--clips", action="store_true",
                    help="one clip per state and switch arm -> OUT/clips/")
    ap.add_argument("--no-live", action="store_true",
                    help="with --clips: never run the game, script frames only")
    args = ap.parse_args()
    try:
        rom = Rom(load_rom())
    except RomError as e:
        print("error: {}".format(e), file=sys.stderr)
        return 1
    if args.make_base:
        make_base()
        return 0
    if args.live:
        os.makedirs(args.out, exist_ok=True)
        live(rom, args.out)
        return 0
    if args.clips:
        if not os.path.isdir(args.base):
            print("error: {} missing; run with --make-base".format(args.base),
                  file=sys.stderr)
            return 1
        clips(rom, args.out, args.base, live_ok=not args.no_live)
        return 0
    info = states(rom, args.player)
    if args.state is not None:
        entry = info["entries"][args.state]
        print("player {} state {} -> $87:{:04X}".format(args.player, args.state, entry))
        for ins in listing(rom, entry):
            print("  $87:{:04X}  {}".format(ins["pc"], fmt_ins(ins)))
        return 0
    if not os.path.isdir(args.base):
        print("error: {} missing; run with --make-base".format(args.base),
              file=sys.stderr)
        return 1
    page, cgram = load_base(args.base)
    os.makedirs(args.out, exist_ok=True)
    rows, index = [], {}
    with open(os.path.join(args.out, "scripts.txt"), "w") as lst:
        lst.write("player {}: state variable $7E:{:04X}, script table $87:{:04X}, "
                  "frame table $89:{:04X}\n".format(
                      args.player, info["var"], info["table_addr"], info["frame_table"]))
        for s, entry in enumerate(info["entries"]):
            lst.write("\nstate {}  $87:{:04X}\n".format(s, entry))
            for ins in listing(rom, entry):
                lst.write("  $87:{:04X}  {}\n".format(ins["pc"], fmt_ins(ins)))
    for s, entry in enumerate(info["entries"]):
        arms, sw = switch_paths(rom, entry, args.arms)
        strips = []
        for arm in arms:
            def choose(ins, arm=arm, sw=sw):
                # Every switch on the same variable takes the same arm: a
                # facing angle is one value for the whole animation.
                if sw is not None and arm is not None and ins.get("var") == sw["var"]:
                    return min(arm, ins["n"] - 1)
                return 0
            p = Player(rom, page, cgram, info["frame_table"],
                       index_var=INDEX_VARS[args.player], state_var=info["var"])
            why = p.run(entry, choose)
            strips.append((arm, p, why))
        frames = [f for _, p, _ in strips for f in p.frames]
        name = "state_{:02d}".format(s)
        entry_info = {"state": s, "entry": "$87:{:04X}".format(entry),
                      "switch": ("*$7E:{:04X} ({} arms)".format(sw["var"], sw["n"])
                                 if sw else None),
                      "arms": []}
        if frames:
            from PIL import Image
            box = objsheets.union_box(frames)
            cw, ch = box[2] - box[0], box[3] - box[1]
            cols = max(len(p.frames) for _, p, _ in strips) or 1
            img = Image.new("RGBA", (cols * cw, len(strips) * ch), (0, 0, 0, 0))
            for r, (arm, p, why) in enumerate(strips):
                for c, f in enumerate(p.frames):
                    img.paste(objsheets.draw(f.parts, f.tiles, f.palettes, box),
                              (c * cw, r * ch))
            img.save(os.path.join(args.out, name + ".png"))
        for arm, p, why in strips:
            entry_info["arms"].append({
                "arm": arm, "stop": why,
                "frames": [{"index": f.index, "list": fmt_snes(FRAME_BANK, f.addr),
                            "wait": f.duration} for f in p.frames],
                "notes": sorted(set(p.notes))})
        index[s] = entry_info
        rows.append([s, "$87:{:04X}".format(entry), entry_info["switch"] or "-",
                     len(strips), sum(len(p.frames) for _, p, _ in strips),
                     ";".join(sorted(set(w for _, _, w in strips))),
                     ";".join(sorted(set(n for _, p, _ in strips for n in p.notes)))[:120]
                     or "-"])
    with open(os.path.join(args.out, "states.json"), "w") as f:
        json.dump(index, f, indent=1)
    live_counts = {}
    lpath = os.path.join(args.out, "live.json")
    if os.path.exists(lpath):
        with open(lpath) as f:
            live_counts = {int(k): len(v["frames"]) for k, v in json.load(f).items()}
    with open(os.path.join(args.out, "states.tsv"), "w") as f:
        f.write("state\tname\tentry\tswitch\tarms\tframes\tlive_pictures\tstop"
                "\tevidence\tnotes\n")
        for r in rows:
            name, why = STATE_NAMES.get(r[0], ("-", "-"))
            if args.player != 1:
                name, why = "-", "see player 1"
            f.write("\t".join(str(c) for c in [r[0], name] + r[1:5] +
                               [live_counts.get(r[0], 0), r[5], why, r[6]]) + "\n")
    print("{} states; wrote {}/scripts.txt, states.tsv, states.json and "
          "state_NN.png".format(len(rows), args.out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
