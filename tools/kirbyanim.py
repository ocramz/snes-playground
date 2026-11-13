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


class Player(object):
    """Replays a script against a tile page, following one arm per switch."""

    def __init__(self, rom, page, cgram, table):
        self.rom = rom
        self.page = bytearray(page)
        self.cgram = bytearray(cgram)
        self.table = table
        self.frames = []
        self.notes = []

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
        f = objsheets.Frame()
        f.addr, f.parts, f.table, f.index = word, parts, self.table, index
        f.duration, f.site, f.flags = max(1, wait), None, [how]
        f.tiles = {t: bytes(self.page[t * 32:t * 32 + 32])
                   for t in objsheets.tiles_of(parts)}
        f.palettes = [[snes_color(self.cgram[0x100 + p * 32 + 2 * i] |
                                  (self.cgram[0x100 + p * 32 + 2 * i + 1] << 8))
                       for i in range(16)] for p in range(8)]
        self.frames.append(f)

    def run(self, entry, choose, max_steps=300, max_frames=48):
        """Run from entry; `choose(ins)` picks a switch arm. Returns why it stopped."""
        # A script that never sets an index keeps the one the previous state
        # left; start from 0, Kirby's standing layout (entry 0 of $89:9295).
        pc, cur, stack, loops, seen = entry, 0, [], [], set()
        changed = False
        for _ in range(max_steps):
            if len(self.frames) >= max_frames:
                return "frame cap"
            ins, nxt = decode(self.rom, pc)
            op = ins["op"]
            a = ins.get("args", [])
            if op == "bad":
                return "bad opcode ${:02X} at $87:{:04X}".format(ins["code"], pc)
            # One cycle of a looping animation is enough: stop when a yield
            # point comes round again with the same switch choices.
            if op in YIELDS:
                key = (pc, cur, len(stack))
                if key in seen:
                    return "loops"
                seen.add(key)
            if op in ("upload_show_wait", "upload_show", "upload_wait", "upload",
                      "upload_palette"):
                self.upload(a[0])
            if op == "upload_palette":
                self.palette(a[1], a[2], a[3])
            if op in ("palette", "palette_wait"):
                self.palette(a[0], a[1], a[2])
            if op in ("upload_switch", "upload_switch_wait"):
                self.upload(ins["table"][choose(ins)])
            if op in ("palette_switch", "palette_switch_wait"):
                self.palette(*ins["table"][choose(ins)])
            if op in ("upload_show_wait", "upload_show"):
                cur = a[1]
            if op in ("show", "show_wait"):
                cur = a[0]
            if op == "show_switch":
                cur = ins["table"][choose(ins)]
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
                        "inc_wait": lambda: a[1], "dec_wait": lambda: a[1]}.get(
                            op, lambda: 4)()
                if op == "show_computed":
                    self.notes.append("computed pose at $87:{:04X}".format(pc))
                elif cur is not None:
                    self.show(cur, wait, "script")
            if op == "jump":
                pc = a[0]
                continue
            if op in ("switch", "call_switch"):
                target = ins["table"][choose(ins)]
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
                # A pose set and then held: the script stops on it, so it is
                # the state's picture even though no wait follows.
                if changed and cur is not None:
                    self.show(cur, 1, "held")
                return op
            pc = nxt
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


# What each state is, from where the game sets it and what it shows: the
# demo or play situation it first occurs in (kirbyanim --live, and the
# writers of $7E:D7D4 logged with snesstep --watch-write) and the pictures.
# These names are interpretations; the evidence column says what they rest
# on. States no run reached are named from their script alone, or left
# unnamed.
STATE_NAMES = {
    0: ("idle", "no animation of its own; seen standing at the tee"),
    1: ("idle (alt)", "same script as 0"),
    2: ("stone: transform", "Stone and Parasol demos; set by a script store"),
    3: ("spark: charged ball", "Spark demo; green and yellow ball"),
    4: ("aiming, 8 facings", "set by $81:A804 while the shot is aimed; "
        "switch on $7E:D7C4, 8 arms = 8 directions"),
    5: ("standing, looking around, 8 facings", "set by $81:A804; switch on $7E:D7C4"),
    6: ("curl into a ball and launch, 16 angles", "set by $81:BEF1 at the shot "
        "(hole 1 frame 2823); switch on $7E:D7CC, 16 arms"),
    7: ("unroll from the ball", "set by $81:C08F after the ball stops; "
        "switch on $7E:D8D2, 11 arms"),
    8: ("copy-ability gained (flash)", "every ability demo, on swallowing the "
        "enemy; black/white palette flashes"),
    9: ("standing, idle variants", "script only; switch on $7E:6AC0"),
    10: ("squashed", "script only"),
    11: ("cheer", "script only; switch on $7E:D7F0"),
    12: ("ball skidding (flattened)", "demos 7-8 and 12, 17"),
    13: ("ball in the air", "hole 1 frame 3020 by $82:DAAE; size follows height"),
    14: ("ball rolling", "hole 1 frame 2984 by $82:C84E"),
    15: ("ball rolling on water", "Shot on the Water demo"),
    16: ("ball rolling (variant)", "script only"), 17: ("ball rolling (variant)",
                                                          "script only"),
    18: ("ball rolling (variant)", "script only"),
    19: ("falling into the cup", "script only"),
    20: ("stone", "Stone demo; switch on $7E:D75A"),
    21: ("fireball, 16 directions", "Fireball demo; switch on $7E:D75E"),
    22: ("needle", "Needle demo"),
    24: ("hi-jump: take-off, 16 directions", "Hi-Jump demo"),
    25: ("hi-jump: in the air, 16 directions", "Hi-Jump demo"),
    26: ("wheel: start, 16 directions", "Wheel demo"),
    27: ("wheel: rolling, 16 directions", "Wheel demo"),
    28: ("wheel: stop", "Wheel demo"),
    29: ("parasol: open", "Parasol demo"),
    30: ("parasol: floating", "Parasol demo, set by $86:A991 also in hole 1"),
    32: ("tornado: start", "Tornado demo"),
    33: ("tornado: spinning, 16 directions", "Tornado demo; switch on $7E:D75A"),
    34: ("tornado: wind-down, 8 directions", "Tornado demo"),
    36: ("freeze", "Freeze demo"),
    37: ("UFO", "UFO demo"),
    49: ("dizzy (hit)", "Objects demo; black/white flash, then spinning eyes"),
}

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


def live(rom, out, every=2):
    """Group Kirby's on-screen frames by animation state, from real play."""
    import shutil
    import emusheets
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
            snap = emusheets.load_snapshot(os.path.join(tmp, d))
            w = snap["wram"]
            w16 = lambda a: w[a] | (w[a + 1] << 8)  # noqa: E731
            # Whoever is drawing Kirby: script object 0 normally, but during
            # a shot it is hidden and a thread object (type 26, table
            # $89:92F3) draws him while his scripts upload the tiles.
            drawn = [(key, addr, table, index) for key, addr, table, index
                     in emusheets.live_frames(rom.d, snap)
                     if table in KIRBY_TABLES and addr >= 0x8000]
            if not drawn:
                continue
            drawn.sort(key=lambda d: d[0][0] != "script")   # script object first
            key, addr, table, index = drawn[0]
            parts = objsheets.frame_parts(rom.d, addr)
            tiles = emusheets.obj_tiles(snap)
            pals = emusheets.obj_palettes(snap["cgram"])
            f = objsheets.Frame()
            f.addr, f.parts, f.table, f.index = addr, parts, table, index
            f.duration, f.site, f.flags = 1, None, ["observed",
                                                    "{}{}".format(*key)]
            f.tiles = {t: tiles[t] for t in objsheets.tiles_of(parts)}
            f.palettes = pals
            used = sorted(set(p["palette"] for p in parts))
            pk = (addr, tuple(sorted(f.tiles.items())),
                  tuple(tuple(pals[p]) for p in used))
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
            p = Player(rom, page, cgram, info["frame_table"])
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
