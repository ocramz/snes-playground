#!/usr/bin/env python3
"""Export one hole as web-ready assets for the Phaser demo in web/.

Everything is derived from the ROM (and from other tools' output under
build/), and everything is written under build/web/ -- gitignored, like every
other derived artifact. web/vite.config.ts serves that directory as its
public dir, so `/course.json` in the browser is build/web/course.json.

    python3 tools/export_web.py                  # hole 0 = course 1, hole 1
    python3 tools/export_web.py --hole 0 --only course,tables,layers
    python3 tools/export_web.py --golden         # + build/web-test fixtures

Steps (--only takes a comma list; default is all that do not need the
emulator or other build/ output):

    manifest  ROM hash, exporter version
    font      the 8x8 font as a glyph sheet
    sprites   the atlas (tools/export_web_sprites.py; needs the stepper)
    ui        the shot panel sprites (tools/export_web_ui.py; needs the stepper)
    audio     music (cut at its loop end), the hole-out songs and effects via ffmpeg
    course    grid layers, tee, enemies, objects, projection origin
    tables    every ROM constant the TypeScript physics needs, each with its
              $bank:addr so a number in the browser can be traced to the ROM
    layers    the isometric course bitmap as RGBA, split by tile priority,
              and the BG3 scenery
    golden    terrain.py's surface_z sampled over every cell (a test fixture)

Facts used here, and where they come from:
    projection  px = 32 (x + y);  py = word7 + 16 (x - y) - 16 Z / $5A82
                word7 is header word 7 (docs/courses.md); checked against the
                first populated BG row in 230 of 232 holes.
    priority    mode 1 with the BG3 priority bit draws, back to front,
                BG2.0, BG1.0, [OBJ priority 2], BG2.1, BG1.1 (coursemap.render).
                Sprites go between the two layer images.
"""

import argparse
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

from courses import ENTRIES, default_entries, header  # noqa: E402
from coursemap import (  # noqa: E402
    EMPTY, backdrop, course_page, course_palette, unpack, BG3_MAP_TILES)
from lorom import snes_to_file  # noqa: E402
from romcheck import EXPECTED_SHA1, RomError, load_rom  # noqa: E402
from terrain import Tables, Z_UNIT, load_hole, tile_table  # noqa: E402
from tiles import decode_tiles  # noqa: E402

VERSION = 1
OUT_DEFAULT = os.path.join(ROOT, "build", "web")
TEST_DEFAULT = os.path.join(ROOT, "build", "web-test")

# Layer 2 values the engine treats specially (docs/tiles.md).
TEE_TILE = 0x0C
ACTOR_ENEMY = 0x49      # object type 73, tiles $40-$52 and $57
ACTOR_PILLAR = 0x48     # object type 72, tile $02


# --------------------------------------------------------------------------
# ROM readers
# --------------------------------------------------------------------------

def rom_words(d, bank, addr, n, signed=False):
    o = snes_to_file(bank, addr)
    out = []
    for i in range(n):
        v = int.from_bytes(d[o + 2 * i:o + 2 * i + 2], "little", signed=signed)
        out.append(v)
    return out


def rom_bytes(d, bank, addr, n, signed=False):
    o = snes_to_file(bank, addr)
    return [int.from_bytes(d[o + i:o + i + 1], "little", signed=signed)
            for i in range(n)]


def src(bank, addr):
    return "${:02X}:{:04X}".format(bank, addr)


# The play-area outline is BG2 palette 7, colour 15, and the game animates
# that one CGRAM entry (an object at $84:81A3 steps it through a table every
# 3 frames; measured with snesstep --watch-write '$7E:04FE-$7E:04FF'). So
# those pixels are written to a separate white mask that the browser tints.
OUTLINE_PAL, OUTLINE_COLOUR = 7, 15
OUTLINE_TABLE = (0x98, 0xD3E6)      # 15 colours; the cycle walks it ping-pong
OUTLINE_WALK = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 13, 14, 13,
                12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]   # emulated, 3 frames each


# --------------------------------------------------------------------------
# tables.json
# --------------------------------------------------------------------------

def build_tables(d):
    tab = Tables(d)
    t = {"about": "ROM tables for web/src/sim. Every entry has a 'source' "
                  "($bank:addr). Words are raw 16-bit values; 'signed' ones "
                  "are already sign-extended.",
         "zUnit": Z_UNIT}

    def put(key, bank, addr, values, width):
        t[key] = {"source": src(bank, addr), "width": width, "values": values}

    put("terrainEdge", 0x81, 0x9310, list(tab.edge), 1)
    put("terrainQuad", 0x81, 0x9D81, list(tab.quad), 2)
    put("terrainQuadDiag", 0x81, 0x9569, list(tab.quad_diag), 2)
    put("terrainDiagBias", 0x81, 0x9629, list(tab.diag_bias), 2)
    put("heightZLo", 0x88, 0x8000, list(tab.z_lo), 2)
    put("heightZHi", 0x88, 0x80C8, list(tab.z_hi), 2)
    put("ramp", 0x88, 0x8190, list(tab.ramp), 2)

    put("sinDeg", 0x80, 0xA5A2, rom_words(d, 0x80, 0xA5A2, 450, True), 2)
    # arctan in degrees by ratio index 0-255 (sub_atan2_deg $80:A4C1)
    put("atanDeg", 0x80, 0xA928, rom_bytes(d, 0x80, 0xA928, 256), 1)
    # per-shape flag: a surface-code change inside the cell throws the ball
    # ($81:980B, the no-edge-crossing case)
    put("crestShape", 0x81, 0x9B45, rom_bytes(d, 0x81, 0x9B45, 28), 1)
    put("degToDir32", 0x81, 0x8E98, rom_bytes(d, 0x81, 0x8E98, 361), 1)

    put("frictionClass", 0x81, 0x8C12, rom_words(d, 0x81, 0x8C12, 13), 2)
    put("rollFriction", 0x80, 0xDC49, rom_words(d, 0x80, 0xDC49, 22 * 4), 2)
    put("ballGravity", 0x80, 0xDB6D, rom_words(d, 0x80, 0xDB6D, 22 * 4, True), 2)
    put("slopeAccelX", 0x81, 0x9E85, rom_words(d, 0x81, 0x9E85, 9, True), 2)
    put("slopeAccelY", 0x81, 0x9E97, rom_words(d, 0x81, 0x9E97, 9, True), 2)
    put("launchX", 0x81, 0x9E61, rom_words(d, 0x81, 0x9E61, 9, True), 2)
    put("launchY", 0x81, 0x9E73, rom_words(d, 0x81, 0x9E73, 9, True), 2)
    put("stepDampMaskX", 0x81, 0x9EA9, rom_words(d, 0x81, 0x9EA9, 4), 2)
    put("stepDampMaskY", 0x81, 0x9EB1, rom_words(d, 0x81, 0x9EB1, 4), 2)
    put("reflectIndex", 0x81, 0x9EB9, rom_words(d, 0x81, 0x9EB9, 16), 2)
    # 13 matrices of 3x3 signed Q15 words, row-major, 18 bytes each.
    put("reflectMatrix", 0x81, 0x9ED9, rom_words(d, 0x81, 0x9ED9, 13 * 9, True), 2)

    put("powerGround", 0x88, 0xA670, rom_words(d, 0x88, 0xA670, 64), 2)
    put("powerFly", 0x88, 0xA6F0, rom_words(d, 0x88, 0xA6F0, 64), 2)
    put("spinGroundTB", 0x80, 0xDD17, rom_bytes(d, 0x80, 0xDD17, 13, True), 1)
    put("curve", 0x80, 0xDD24, rom_bytes(d, 0x80, 0xDD24, 13, True), 1)
    put("spinFlyTB", 0x80, 0xDD33, rom_words(d, 0x80, 0xDD33, 13, True), 2)
    put("spinFlySide", 0x80, 0xDD4D, rom_bytes(d, 0x80, 0xDD4D, 13, True), 1)
    put("buttonModifier", 0x82, 0xDB75, rom_words(d, 0x82, 0xDB75, 2, True), 2)
    # The shot view: Kirby's screen position + this offset by aim quarter
    # (0-89, 90-179, 180-269, 270-359), where the camera pans after the aim
    # is confirmed ($81:BE9A-$81:BEC7; docs/web-demo.md "Camera").
    put("shotViewX", 0x81, 0xC0F0, rom_words(d, 0x81, 0xC0F0, 4, True), 2)
    put("shotViewY", 0x81, 0xC0F8, rom_words(d, 0x81, 0xC0F8, 4, True), 2)
    # The shot guide's own tile classes ($81:B455, read by $81:B0C4 and
    # $81:B285): 1 = the play-area outline ($28-$2D), 2 = the surface
    # overlay ($60-$6F), 0 = plain ground (pillars, enemies, the cup and
    # every other special tile are invisible to the guide).
    put("guideTiles", 0x81, 0xB455, rom_bytes(d, 0x81, 0xB455, 256), 1)

    # The cup's dish: 32 x 32 words, row = folded y fraction >> 10, column =
    # folded x fraction >> 10 (sub_cup_depth $82:AFE9). $5000 = flat centre.
    put("cupDepth", 0x88, 0x8990, rom_words(d, 0x88, 0x8990, 32 * 32), 2)

    # --- The special-tile dispatch ($81:8136 land, $81:8451 hit from the
    # side): 256 entries of 3-byte long pointers each (docs/tiles.md "The
    # dispatcher"). Exported as per-tile handler ids into the shared
    # dispatchHandlers list, so the engine switches on a small enum rather
    # than parsing ROM pointers. Every group must be named here; an unnamed
    # group fails the export instead of slipping through silently.
    handler_names = {
        (0x81, 0x88F9): "landClear",        # tile $00 on land: clears per-player tracking, then land
        (0x81, 0x8905): "land",             # the default landing handler
        (0x81, 0x8A47): "rollClear",        # tile $00 on roll: clears per-player tracking, then roll
        (0x81, 0x8A56): "roll",             # the default rolling handler
        (0x82, 0x94D3): "pillar",           (0x82, 0x957C): "pillarHit",      # $02
        (0x82, 0x8EFB): "rough",            (0x82, 0x8F30): "roughHit",       # $04
        (0x82, 0xA55E): "hazard05",         (0x82, 0xA576): "hazard05Hit",    # $05
        (0x82, 0xAD8E): "cup",              (0x82, 0xAD36): "cupHit",         # $08
        (0x82, 0xA7DD): "kicker",           (0x82, 0xA88C): "kickerHit",      # $10-$13
        (0x82, 0xA6C7): "unk14",            (0x82, 0xA74F): "unk14Hit",       # $14, $16 (undocumented)
        (0x82, 0xA70B): "unk15",            (0x82, 0xA783): "unk15Hit",       # $15, $17 (undocumented)
        (0x82, 0xA5B1): "snap",             (0x82, 0xA5E6): "snapHit",        # $18-$1B
        (0x82, 0x9342): "rough05",          (0x82, 0x9356): "rough05Hit",     # $1C ($936A shared with $05)
        (0x82, 0x938E): "rough05b",         (0x82, 0x93A2): "rough05bHit",    # $1D ($93B6 shared with $05)
        (0x82, 0x8F77): "friction",         (0x82, 0x8F9D): "frictionHit",    # $20-$24
        (0x82, 0x8FF1): "outlineWall",      (0x82, 0x8FE3): "outlineWallHit", # $28-$2D
        (0x82, 0x9DB3): "boostN",           (0x82, 0x9CBF): "boostNHit",      # $30 $35 $38
        (0x82, 0x9DD7): "boostE",           (0x82, 0x9CFC): "boostEHit",      # $31 $37 $3A
        (0x82, 0x9DFB): "boostS",           (0x82, 0x9D39): "boostSHit",      # $32 $34 $39
        (0x82, 0x9E1F): "boostW",           (0x82, 0x9D76): "boostWHit",      # $33 $36 $3B
        (0x82, 0x8967): "enemy",            # $40-$52, $57 on land; $40-$4C, $57 on roll
        (0x82, 0x8963): "enemyRollAlt",     # $4D-$52 on roll (no owner test)
        (0x82, 0xA25D): "unk58",            (0x82, 0xA2F5): "unk58Hit",       # $58, $59 (undocumented)
        (0x82, 0xA1B1): "unk5a",            (0x82, 0xA175): "unk5aHit",       # $5A, $5B (undocumented)
        (0x82, 0xA3EB): "unk5c",            (0x82, 0xA43E): "unk5cHit",       # $5C, $5D (undocumented)
        (0x82, 0x80F6): "overlay",          (0x82, 0x8000): "overlayHit",     # $60-$6F
        # $70-$7B: the toggled directional impulse, one handler per tile
        (0x82, 0x9FE3): "toggle70", (0x82, 0x9F0B): "toggle70Hit",
        (0x82, 0xA01A): "toggle71", (0x82, 0x9F3D): "toggle71Hit",
        (0x82, 0x9FFF): "toggle72", (0x82, 0x9F24): "toggle72Hit",
        (0x82, 0xA035): "toggle73", (0x82, 0x9F56): "toggle73Hit",
        (0x82, 0x9FD1): "toggle74", (0x82, 0x9EF9): "toggle74Hit",
        (0x82, 0xA008): "toggle75", (0x82, 0x9F2B): "toggle75Hit",
        (0x82, 0x9FED): "toggle76", (0x82, 0x9F12): "toggle76Hit",
        (0x82, 0xA023): "toggle77", (0x82, 0x9F44): "toggle77Hit",
        (0x82, 0x9FDA): "toggle78", (0x82, 0x9F02): "toggle78Hit",
        (0x82, 0xA011): "toggle79", (0x82, 0x9F34): "toggle79Hit",
        (0x82, 0x9FF6): "toggle7A", (0x82, 0x9F1B): "toggle7AHit",
        (0x82, 0xA02C): "toggle7B", (0x82, 0x9F4D): "toggle7BHit",
        (0x82, 0x98F8): "hazard80",         (0x82, 0x9940): "hazard80Hit",    # $80-$8F, $98-$A1
        (0x82, 0x9653): "hazard90",         (0x82, 0x9693): "hazard90Hit",    # $90-$97
        (0x82, 0x9858): "hazardA2",         (0x82, 0x987B): "hazardA2Hit",    # $A2
        (0x82, 0x86B9): "hazardAC",         (0x82, 0x8656): "hazardACHit",    # $AC-$AE
        (0x82, 0xA980): "unkB0",            (0x82, 0xA9DB): "unkB0Hit",       # $B0-$B9 (undocumented)
    }

    def dispatch_ids(bank, addr):
        o = snes_to_file(bank, addr)
        ptrs = []
        for i in range(256):
            lo, hi, bk = d[o + 3 * i], d[o + 3 * i + 1], d[o + 3 * i + 2]
            ptrs.append((bk, (hi << 8) | lo))
        order = []
        for p in ptrs:
            if p not in order:
                order.append(p)
        return [order.index(p) for p in ptrs], order

    land_ptrs = []
    hit_ptrs = []
    def dispatch_ptrs(bank, addr, out):
        o = snes_to_file(bank, addr)
        for i in range(256):
            lo, hi, bk = d[o + 3 * i], d[o + 3 * i + 1], d[o + 3 * i + 2]
            out.append((bk, (hi << 8) | lo))
    dispatch_ptrs(0x81, 0x8136, land_ptrs)
    dispatch_ptrs(0x81, 0x8451, hit_ptrs)
    order = []
    for p in land_ptrs + hit_ptrs:
        if p not in order:
            order.append(p)
    handlers = []
    for p in order:
        name = handler_names.get(p)
        assert name is not None, "unnamed dispatch handler {}".format(src(*p))
        handlers.append({"id": len(handlers), "name": name, "source": src(*p)})
    ids = {p: h["id"] for h, p in zip(handlers, order)}
    t["dispatchHandlers"] = handlers
    put("landDispatch", 0x81, 0x8136, [ids[p] for p in land_ptrs], 1)
    put("hitDispatch", 0x81, 0x8451, [ids[p] for p in hit_ptrs], 1)

    # --- The outline-wall line test ($82:9019), as data:
    # outlineLineTouch[tile * 4 + dir]: does the tile's line reach the edge
    #   the ball exits through (dir 0..3 = the $0C movement code -y,-x,+x,+y);
    # outlineContinuation[dir * 4 + i]: the three prev-tile values ($28 base)
    #   whose line continues across that edge;
    # outlineConnect[sidePair * 36 + prevTile * 6 + curTile]: how two lines
    #   join across a cell boundary (0 = not connected, 1/2 = crossed),
    #   sidePair = prevSide * 2 + curSide, sides from the line test.
    line_touch = rom_bytes(d, 0x82, 0x9202, 24)
    continuation = rom_bytes(d, 0x82, 0x921A, 24)
    connect = []
    for side, addr in enumerate((0x922A, 0x924E, 0x9272, 0x9296)):
        block = rom_bytes(d, 0x82, addr, 36)
        assert all(0 <= v <= 3 for v in block), "outlineConnect block out of range"
        connect.extend(block)
    put("outlineLineTouch", 0x82, 0x9202, line_touch, 1)
    put("outlineContinuation", 0x82, 0x921A, continuation, 1)
    # $81:92D0: the wall direction byte, indexed prevShape * 4 + edge
    put("wallDirTable", 0x81, 0x92D0, rom_bytes(d, 0x81, 0x92D0, 16), 1)
    put("outlineConnect", 0x82, 0x922A, connect, 1)

    # per-mode tables of the rough ($05/$1C/$1D) and friction-tile ($04)
    # handlers: 22 words each, indexed by ball mode.
    put("hazard05Mode", 0x80, 0xDDB7, rom_words(d, 0x80, 0xDDB7, 22, True), 2)
    put("hazard05ModeHit", 0x80, 0xDD8B, rom_words(d, 0x80, 0xDD8B, 22, True), 2)
    put("frictionAltMode", 0x80, 0xDDF5, rom_words(d, 0x80, 0xDDF5, 22, True), 2)
    put("frictionAltIndex", 0x80, 0xDE21, rom_words(d, 0x80, 0xDE21, 22), 2)
    # $82:8F4e indexes these three with the frictionAltIndex value (0 or 2)
    assert all(v <= 2 for v in rom_words(d, 0x80, 0xDE21, 22)), "frictionAltIndex out of range"
    put("roughFriction", 0x80, 0xDD71, rom_words(d, 0x80, 0xDD71, 4, True), 2)
    put("roughDampXY", 0x80, 0xDD75, rom_words(d, 0x80, 0xDD75, 4, True), 2)
    put("roughDampZ", 0x80, 0xDD79, rom_words(d, 0x80, 0xDD79, 4, True), 2)

    # The play-area outline pulse (OUTLINE_* above): 15 CGRAM colours the
    # game steps one entry of BG2 palette 7 through. The walk is emulated,
    # not ROM data; keep it inside the table so a bad edit fails at export.
    assert all(0 <= i < 15 for i in OUTLINE_WALK), "outline walk outside the table"
    put("outlineColours", OUTLINE_TABLE[0], OUTLINE_TABLE[1],
        rom_words(d, OUTLINE_TABLE[0], OUTLINE_TABLE[1], 15), 2)
    t["outlineWalk"] = {"about": "ping-pong order into outlineColours, one "
                                 "step every 3 frames; emulated (object "
                                 "$84:81A3), not ROM data",
                        "values": list(OUTLINE_WALK)}

    def scalar(key, bank, addr, signed=False):
        t.setdefault("consts", {})[key] = {
            "source": src(bank, addr),
            "value": rom_words(d, bank, addr, 1, signed)[0]}

    scalar("bounceMinFrames", 0x80, 0xDCFD)
    scalar("restSpeed", 0x80, 0xDD01)
    scalar("powerScale", 0x80, 0xDD03)
    scalar("flySpinBase", 0x80, 0xDD05)
    scalar("rollFrictionDefault", 0x80, 0xDD0D)
    scalar("bounceDampXY", 0x80, 0xDD0F)
    scalar("bounceDampZ", 0x80, 0xDD11)
    scalar("stepDamp", 0x80, 0xDD13)
    scalar("stepDampZ", 0x80, 0xDD15)
    # --- special-tile handler constants ---
    # friction tile $20-$24 ($82:8FA4) and the rough tile $04 ($82:8EFB)
    scalar("frictionTileMu", 0x80, 0xDD7D)
    scalar("frictionTileDampXY", 0x80, 0xDD7F)
    scalar("frictionTileDampZ", 0x80, 0xDD81)
    scalar("roughDampXY2", 0x80, 0xDD83)
    scalar("roughDampZ", 0x80, 0xDD85)
    scalar("roughDampZ6", 0x80, 0xDD87)
    # boost panels ($82:9DB3+ land, $82:9CBF+ hit): impulses and gates
    scalar("boostResetMu", 0x82, 0x9CAB, True)
    scalar("boostResetDampXY", 0x82, 0x9CAD, True)
    scalar("boostResetDampZ", 0x82, 0x9CAF, True)
    scalar("boostSmall", 0x82, 0x9CB1, True)       # $0040: the hit-path nudge
    scalar("boostSmallNeg", 0x82, 0x9CB3, True)    # $FFC0
    scalar("boostE", 0x82, 0x9CB5, True)           # $0200: +512 along +x/+y
    scalar("boostW", 0x82, 0x9CB7, True)           # $FE00: -512
    scalar("boostBig", 0x82, 0x9CB9, True)         # $0400: the hit-path launch clamp
    scalar("boostBigNeg", 0x82, 0x9CBB, True)      # $FC00
    scalar("boostStraight", 0x82, 0x9CBD, True)    # $0080: |v| below this = straight hit
    # kicker ($82:A7DD): the landing-vz clamp pair, two entries (normal, mode 6)
    put("kickerMin", 0x80, 0xDDE3, rom_words(d, 0x80, 0xDDE3, 2), 2)
    put("kickerMax", 0x80, 0xDDE5, rom_words(d, 0x80, 0xDDE5, 2), 2)
    scalar("kickerDamp", 0x80, 0xDDEB)
    # kicker per-mode gates ($82:A7DD/$82:A88C), 22 words each
    put("kickerMode", 0x80, 0xDEA5, rom_words(d, 0x80, 0xDEA5, 22), 2)
    put("kickerModeHit", 0x80, 0xDED1, rom_words(d, 0x80, 0xDED1, 22), 2)
    # toggled impulse ($70-$7B): the two magnitudes (tiles.md)
    scalar("toggleImpulseBig", 0x80, 0xDDED)
    scalar("toggleImpulseSmall", 0x80, 0xDDEF)
    # rough/hazard-05 recovery launch ($82:93DA)
    scalar("hazard05Div", 0x80, 0xDD89)

    return t


# --------------------------------------------------------------------------
# course.json
# --------------------------------------------------------------------------

def build_course(d, defaults, index):
    got = load_hole(d, defaults, index)
    if got is None:
        raise SystemExit("hole {} has no usable grids".format(index))
    fields, name, w, h, layers = got
    l1, l2, l3, l4 = layers[1], layers[2], layers[3], layers[4]
    has_tiles = len(l2) >= w * h
    n = w * h

    actor_off = snes_to_file(0x82, 0xBDBC)
    actors = [int.from_bytes(d[actor_off + 2 * i:actor_off + 2 * i + 2], "little")
              for i in range(256)]

    tee, enemies, objects, edges = None, [], [], []
    tiles = list(l2[:n]) if has_tiles else [0] * n
    for j, tile in enumerate(tiles):
        if not tile:
            continue
        x, y = j % w, j // w
        if tile == TEE_TILE:
            tee = {"x": x, "y": y, "elevation": l3[j]}
        actor = actors[tile]
        if actor == ACTOR_ENEMY:
            enemies.append({"x": x, "y": y, "tile": tile, "actor": actor})
        elif actor != 0xFFFF:
            objects.append({"x": x, "y": y, "tile": tile, "actor": actor,
                            "type": actor})        # an actor id is the object type
        if 0x28 <= tile <= 0x2D:
            edges.append({"x": x, "y": y, "tile": tile})

    map_w, map_h = fields[4], fields[5]
    return {
        "index": index, "name": name, "header": list(fields),
        "w": w, "h": h,
        "bitmap": {"w": map_w * 8, "h": map_h * 8},
        "word7": fields[7],
        "zUnit": Z_UNIT,
        "projection": {"sx": 32, "sy": 16, "syPerStep": 16, "originY": fields[7]},
        "shape": list(l1[:n]), "elev": list(l3[:n]), "walls": list(l4[:n]),
        "tile": tiles,
        "tee": tee, "enemies": enemies, "objects": objects, "edgeTiles": edges,
    }


# --------------------------------------------------------------------------
# layers
# --------------------------------------------------------------------------

def blit_rgba(img, pal, tiles, word, y, x, outline=None):
    """Draw one tilemap cell into an (H, W, 4) array; colour 0 is transparent.

    With `outline` (an (H, W, 4) array), the outline colour goes there as
    white instead of into `img`.
    """
    import numpy as np
    idx = word & 0x3FF
    if idx >= len(tiles):
        return
    rows = tiles[idx]
    if (word >> 14) & 1:
        rows = [row[::-1] for row in rows]
    if (word >> 15) & 1:
        rows = rows[::-1]
    cell = np.array(rows, dtype=np.uint8)
    view = img[y:y + 8, x:x + 8]
    if view.shape[0] != 8 or view.shape[1] != 8:
        return
    mask = cell != 0
    colours = np.array(pal[(word >> 10) & 7], dtype=np.uint8)
    if outline is not None and ((word >> 10) & 7) == OUTLINE_PAL:
        ol = cell == OUTLINE_COLOUR
        oview = outline[y:y + 8, x:x + 8]
        oview[ol] = 255
        mask = mask & ~ol
    view[mask, :3] = colours[cell[mask]]
    view[mask, 3] = 255


def build_layers(d, index, outdir):
    import numpy as np
    from PIL import Image

    _, fields, name, _ = header(d, index)
    map_w, map_h, g1, g2, _rows = unpack(d, index, fields)
    tiles = decode_tiles(course_page(d), 4)
    pal = course_palette(d)
    W, H = map_w * 8, map_h * 8

    def compose(want, pal=pal):
        img = np.zeros((H, W, 4), dtype=np.uint8)
        ol = np.zeros((H, W, 4), dtype=np.uint8)
        # BG2 is behind BG1 at the same priority.
        for grid in (g2, g1):
            for i, wd in enumerate(grid):
                if wd == EMPTY or ((wd >> 13) & 1) != want:
                    continue
                y, x = divmod(i, map_w)
                blit_rgba(img, pal, tiles, wd, y * 8, x * 8, outline=ol)
        return img, ol

    (back, ol_back), (front, ol_front) = compose(0), compose(1)
    wrote = {}
    for name_, arr in (("layer_back.png", back), ("layer_front.png", front),
                       ("layer_outline_back.png", ol_back),
                       ("layer_outline_front.png", ol_front)):
        path = os.path.join(outdir, name_)
        if arr[:, :, 3].any():
            Image.fromarray(arr, "RGBA").save(path)
            wrote[name_] = [W, H]
        elif os.path.exists(path):
            os.remove(path)

    # BG3 scenery: one 32x32-tile screen with the per-course palette. Groups
    # of four colours, as coursemap.render builds them.
    page, tmap, cols = backdrop(d, index)
    cells = decode_tiles(page, 2)

    def bg3(cols, path):
        pal2 = [[cols[g * 4 + c] for c in range(4)] for g in range(8)]
        sky = np.zeros((BG3_MAP_TILES * 8, BG3_MAP_TILES * 8, 4), dtype=np.uint8)
        for want in (0, 1):
            for i, wd in enumerate(tmap[:BG3_MAP_TILES * BG3_MAP_TILES]):
                if ((wd >> 13) & 1) != want:
                    continue
                cy, cx = divmod(i, BG3_MAP_TILES)
                blit_rgba(sky, pal2, cells, wd, cy * 8, cx * 8)
        Image.fromarray(sky, "RGBA").save(os.path.join(outdir, path))
        wrote[path] = [256, 256]

    bg3(cols, "layer_bg3.png")
    # The HOLE IN ONE sequence swaps the BG palettes for a night set (recorded
    # by tools/snesstep/trace_cutscene.py; only hole 1's run is recorded).
    # Every CGRAM entry that differs between the two recorded palettes takes
    # its night value; the others keep the ROM colours used above.
    night = None
    if index == 0:
        import export_web_sprites
        night = export_web_sprites.night_cgram()
    night_back = None
    if night:
        day_cg, night_cg = night
        changed = {i: night_cg[i] for i in range(128)
                   if day_cg[i] != night_cg[i] and i != OUTLINE_PAL * 16 + OUTLINE_COLOUR}
        pal_n = [[changed.get(p * 16 + c, pal[p][c]) for c in range(16)] for p in range(len(pal))]
        for want, path in ((0, "layer_back_night.png"), (1, "layer_front_night.png")):
            arr, _ = compose(want, pal_n)
            if arr[:, :, 3].any():
                Image.fromarray(arr, "RGBA").save(os.path.join(outdir, path))
                wrote[path] = [W, H]
        bg3([changed.get(i, c) for i, c in enumerate(cols)], "layer_bg3_night.png")
        night_back = list(changed.get(0, cols[0]))
    # The backdrop colour behind everything is the course palette's colour 0.
    from tiles import snes_color
    table = [snes_color(w) for w in rom_words(d, OUTLINE_TABLE[0], OUTLINE_TABLE[1], 15)]
    return {"files": wrote, "backColour": list(cols[0]), "name": name,
            "nightBackColour": night_back,
            "outline": {"source": src(*OUTLINE_TABLE), "stepFrames": 3,
                        "cycle": [list(table[i]) for i in OUTLINE_WALK]}}


# --------------------------------------------------------------------------
# font

def build_font(d, outdir):
    """The game's 8x8 font (docs/text.md) as one 16-glyph-wide RGBA sheet,
    glyph index = tile index = the game's character code."""
    import numpy as np
    from PIL import Image
    import text as text_mod
    tiles = text_mod.font_tiles(d)
    cols = 16
    rows = (len(tiles) + cols - 1) // cols
    sheet = np.zeros((rows * 8, cols * 8, 4), dtype=np.uint8)
    # glyph pixels are value 3; value 1 is the cell background, 2 is rare
    shades = [None, None, (200, 200, 230, 255), (255, 255, 255, 255)]
    for i, t in enumerate(tiles):
        r, c = divmod(i, cols)
        for y in range(8):
            for x in range(8):
                v = t[y][x]
                if shades[v]:
                    sheet[r * 8 + y, c * 8 + x] = shades[v]
    Image.fromarray(sheet, "RGBA").save(os.path.join(outdir, "font.png"))
    return {"glyphs": len(tiles), "cols": cols}


# --------------------------------------------------------------------------
# HUD

HUD_SRC = os.path.join(ROOT, "build", "screens", "hole_in_play_layers", "bg3.png")


def build_hud(outdir):
    """The in-play panel (BG3 of an emulated frame), with the numbers and the
    tomatoes blanked so the browser can draw its own. Coordinates are screen
    pixels of that 256x224 frame (measured on build/screens/hole_in_play)."""
    from PIL import Image
    if not os.path.exists(HUD_SRC):
        print("hud: {} missing (tools/snesstep/screens.py makes it); skipped".format(HUD_SRC))
        return None
    im = Image.open(HUD_SRC).convert("RGBA")
    panel = im.crop((16, 176, 240, 208))
    px = panel.load()

    def fill(box, colour):
        x0, y0, x1, y1 = box
        for y in range(y0 - 176, y1 - 176):
            for x in range(x0 - 16, x1 - 16):
                px[x, y] = colour

    # Where BG3 draws nothing the game shows the course through a darkening
    # window; a flat dark colour stands in for it.
    dark = (24, 24, 24, 255)
    orange = (255, 189, 107, 255)        # the SHOT / HOLE box
    back = (40, 40, 48, 255)
    strip = (214, 148, 247, 255)         # the lilac star-count strip
    for y in range(panel.height):
        for x in range(panel.width):
            if px[x, y][3] == 0:
                px[x, y] = back
    tom = im.crop((164, 183, 182, 199))  # one tomato with its leaf, 18 x 16
    fill((24, 184, 48, 208), back)       # the portrait window shows scenery: blank it
    fill((111, 194, 127, 207), dark)
    fill((136, 193, 153, 207), orange)
    fill((163, 182, 231, 199), back)
    fill((197, 199, 219, 208), strip)
    panel.save(os.path.join(outdir, "hud_panel.png"))
    tom.save(os.path.join(outdir, "hud_tomato.png"))
    return {"panel": [224, 32], "at": [16, 176], "tomato": list(tom.size),
            "slots": {"hole": [111, 194], "shot": [136, 193], "tomato": [164, 183],
                      "tomatoStep": 16, "stars": [200, 200]}}


# --------------------------------------------------------------------------
# audio

WAV_DIR = os.path.join(ROOT, "build", "spc", "wav")


def encode(src_wav, dst_base, seconds=None):
    """ogg vorbis, plus an mp3 for browsers that cannot decode it."""
    import subprocess
    base = ["ffmpeg", "-y", "-loglevel", "error", "-i", src_wav]
    if seconds:
        base += ["-t", str(seconds)]
    subprocess.run(base + ["-c:a", "libvorbis", "-q:a", "4", dst_base + ".ogg"], check=True)
    subprocess.run(base + ["-c:a", "libmp3lame", "-q:a", "4", dst_base + ".mp3"], check=True)


def build_audio(outdir):
    """music (cut at its loop end), the songs of the intro and the hole-out,
    and the effects the demo plays, with the loop points the browser needs."""
    import csv
    amap = json.load(open(os.path.join(HERE, "web_audio_map.json")))
    index = os.path.join(WAV_DIR, "index.tsv")
    if not os.path.exists(index):
        print("audio: {} missing (tools/render_audio.py makes it); skipped".format(index))
        return None
    rows = {}
    with open(index) as f:
        for r in csv.DictReader(f, delimiter="\t"):
            rows[(r["kind"], r["id"])] = r

    def song(n, name):
        row = rows[("song", "{:02d}".format(n))]
        src = os.path.join(WAV_DIR, "songs", "song_{:02d}.wav".format(n))
        if row["loop_start_s"] not in ("", "-"):
            start, length = float(row["loop_start_s"]), float(row["loop_length_s"])
            end = start + length
            encode(src, os.path.join(outdir, name), seconds=round(end + 0.05, 3))
            return {"file": name + ".ogg", "loopStart": round(start, 4), "loopEnd": round(end, 4)}
        encode(src, os.path.join(outdir, name))
        return {"file": name + ".ogg"}

    out = {"music": song(amap["music"]["song"], "music"), "songs": {}}
    # the songs keep the game's numbering: request id $7E + n is song n
    out["songs"][str(amap["music"]["song"])] = out["music"]
    for n in amap.get("songs", {}):
        out["songs"][n] = song(int(n), "song_{:02d}".format(int(n)))
    out["sfx"] = {}
    for sid in amap["sfx"]:
        name = "sfx_{:02X}".format(int(sid))
        encode(os.path.join(WAV_DIR, "sfx", name + ".wav"), os.path.join(outdir, name))
        out["sfx"][sid] = name + ".ogg"
    write_json(os.path.join(outdir, "audio.json"), out, compact=False)
    return {"music": out["music"], "songs": sorted(out["songs"]), "sfx": len(out["sfx"])}


# --------------------------------------------------------------------------
# golden terrain fixture
# --------------------------------------------------------------------------

def build_golden(d, defaults, index):
    tab = Tables(d)
    _, _, w, h, layers = load_hole(d, defaults, index)
    l1, l3 = layers[1], layers[3]
    fracs = sorted(set([k * 0x1000 for k in range(16)] + [0x7FFF, 0x8000, 0xFFFF]))
    z = []
    for j in range(w * h):
        for yf in fracs:
            for xf in fracs:
                z.append(tab.surface_z(l1[j], l3[j], xf, yf))
    return {"about": "Tables.surface_z (tools/terrain.py) for every cell, "
                     "row-major, then yf, then xf.",
            "w": w, "h": h, "fracs": fracs, "z": z}


# --------------------------------------------------------------------------

def write_json(path, obj, compact=True):
    with open(path, "w") as f:
        if compact:
            json.dump(obj, f, separators=(",", ":"))
        else:
            json.dump(obj, f, indent=1)


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--hole", type=int, default=0, help="hole index (course*8+hole)")
    ap.add_argument("--out", default=OUT_DEFAULT)
    ap.add_argument("--test-out", default=TEST_DEFAULT)
    ap.add_argument("--only", default="manifest,course,tables,layers,font,hud,sprites,ui,audio",
                    help="comma list of steps")
    ap.add_argument("--golden", action="store_true",
                    help="also write the terrain golden fixture")
    args = ap.parse_args()
    steps = set(args.only.split(","))
    if args.golden:
        steps.add("golden")

    try:
        d = load_rom()
    except RomError as e:
        print("error: {}".format(e), file=sys.stderr)
        return 1
    defaults = default_entries(d)
    os.makedirs(args.out, exist_ok=True)

    if "course" in steps:
        course = build_course(d, defaults, args.hole)
        write_json(os.path.join(args.out, "course.json"), course)
        print("course.json: hole {} {} {}x{}, {} enemies, {} objects, tee {}".format(
            args.hole, course["name"], course["w"], course["h"],
            len(course["enemies"]), len(course["objects"]), course["tee"]))
    if "tables" in steps:
        write_json(os.path.join(args.out, "tables.json"), build_tables(d))
        print("tables.json written")
    if "layers" in steps:
        info = build_layers(d, args.hole, args.out)
        write_json(os.path.join(args.out, "layers.json"), info, compact=False)
        print("layers: {}".format(info["files"]))
    if "font" in steps:
        info = build_font(d, args.out)
        print("font.png: {}".format(info))
    if "audio" in steps:
        print("audio: {}".format(build_audio(args.out)))
    if "hud" in steps:
        print("hud: {}".format(build_hud(args.out)))
    if "sprites" in steps:
        import export_web_sprites
        print("sprites: {}".format(export_web_sprites.build(args.out)))
    if "ui" in steps:
        import export_web_ui
        print("ui: {}".format(export_web_ui.build(args.out)))
    if "golden" in steps:
        os.makedirs(args.test_out, exist_ok=True)
        write_json(os.path.join(args.test_out, "terrain_golden.json"),
                   build_golden(d, defaults, args.hole))
        print("terrain_golden.json written to {}".format(args.test_out))
    if "manifest" in steps:
        files = sorted(f for f in os.listdir(args.out) if f != "manifest.json")
        write_json(os.path.join(args.out, "manifest.json"), {
            "exporter": VERSION, "hole": args.hole, "romSha1": EXPECTED_SHA1,
            "files": files}, compact=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
