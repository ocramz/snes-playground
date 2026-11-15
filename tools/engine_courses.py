#!/usr/bin/env python3
"""The engine's eight test holes, engine/courses/t*.course.json (engine phase 6).

    python3 tools/engine_courses.py            # writes engine/courses/

Each hole is a base fill (flat, elevation 0) with features stamped onto it: a
hill or a hollow of ramps and corner pieces, terraces, gaps, a fence of
layer-4 walls, the special tiles. The edge levels (N, E, S, W, in half
steps; $81:9310, docs/terrain.md) decide what joins flush; the script prints
every mismatched edge, so the steps that remain are the deliberate ones (the
terraces' rims, the diagonal crown). The files are the source of truth the
tests read; this script is only how they were laid out.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(HERE), "engine", "courses")
EDGES = [
    (0, 0, 0, 0), (2, 2, 2, 2), (0, 0, 0, 0), (2, 2, 2, 2), (0, 1, 2, 1), (1, 0, 1, 2), (2, 1, 0, 1), (1, 2, 1, 0),
    (1, 1, 2, 2), (2, 1, 1, 2), (2, 2, 1, 1), (1, 2, 2, 1), (0, 0, 1, 1), (1, 0, 0, 1), (1, 1, 0, 0), (0, 1, 1, 0),
    (1, 1, 2, 2), (2, 1, 1, 2), (2, 2, 1, 1), (1, 2, 2, 1), (0, 0, 1, 1), (1, 0, 0, 1), (1, 1, 0, 0), (0, 1, 1, 0),
    (1, 1, 3, 3), (3, 1, 1, 3), (3, 3, 1, 1), (1, 3, 3, 1),
]


class Hole:
    def __init__(self, name, about, w, h, shape=1, elev=0):
        self.name, self.about, self.w, self.h = name, about, w, h
        self.shape = [[shape] * w for _ in range(h)]
        self.elev = [[elev] * w for _ in range(h)]
        self.walls = [[0] * w for _ in range(h)]
        self.tile = [[0] * w for _ in range(h)]

    def put(self, x, y, shape=None, elev=None, tile=None, walls=None):
        if shape is not None: self.shape[y][x] = shape
        if elev is not None: self.elev[y][x] = elev
        if tile is not None: self.tile[y][x] = tile
        if walls is not None: self.walls[y][x] |= walls

    def rect(self, x0, y0, x1, y1, **kw):
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                self.put(x, y, **kw)

    def gap(self, x0, y0, x1, y1):
        self.rect(x0, y0, x1, y1, shape=0, elev=0, tile=0)

    def fence(self):
        """Layer-4 walls on every edge that faces a gap or the grid's border."""
        for y in range(self.h):
            for x in range(self.w):
                if self.shape[y][x] == 0: continue
                for bit, (dx, dy) in zip((1, 2, 4, 8), ((0, -1), (1, 0), (0, 1), (-1, 0))):
                    nx, ny = x + dx, y + dy
                    if not (0 <= nx < self.w and 0 <= ny < self.h) or self.shape[ny][nx] == 0:
                        self.walls[y][x] |= bit

    def hill(self, x, y, elev=1, diagonal=False):
        """A one-cell plateau at `elev` with ramps down to elev - 1."""
        c = 0x14 if diagonal else 0x0C
        self.put(x, y, shape=1, elev=elev)
        self.put(x, y - 1, shape=0x04, elev=elev)
        self.put(x, y + 1, shape=0x06, elev=elev)
        self.put(x - 1, y, shape=0x07, elev=elev)
        self.put(x + 1, y, shape=0x05, elev=elev)
        self.put(x - 1, y - 1, shape=c + 3, elev=elev)  # NW (0,1,1,0)
        self.put(x + 1, y - 1, shape=c + 0, elev=elev)  # NE (0,0,1,1)
        self.put(x + 1, y + 1, shape=c + 1, elev=elev)  # SE (1,0,0,1)
        self.put(x - 1, y + 1, shape=c + 2, elev=elev)  # SW (1,1,0,0)

    def pit(self, x, y, elev=1, diagonal=False):
        """A one-cell hollow at elev - 1 with ramps up to a terrace at `elev`."""
        c = 0x10 if diagonal else 0x08
        self.rect(x - 2, y - 2, x + 2, y + 2, shape=1, elev=elev)
        self.put(x, y, shape=1, elev=elev - 1)
        self.put(x, y - 1, shape=0x06, elev=elev)
        self.put(x, y + 1, shape=0x04, elev=elev)
        self.put(x - 1, y, shape=0x05, elev=elev)
        self.put(x + 1, y, shape=0x07, elev=elev)
        self.put(x - 1, y - 1, shape=c + 1, elev=elev)  # NW (2,1,1,2)
        self.put(x + 1, y - 1, shape=c + 2, elev=elev)  # NE (2,2,1,1)
        self.put(x + 1, y + 1, shape=c + 3, elev=elev)  # SE (1,2,2,1)
        self.put(x - 1, y + 1, shape=c + 0, elev=elev)  # SW (1,1,2,2)
        # the terrace's way in: a ramp up from the floor on its west side
        self.put(x - 2, y, shape=0x07, elev=elev)

    def mismatches(self):
        out = []
        for y in range(self.h):
            for x in range(self.w):
                s = self.shape[y][x]
                if s == 0: continue
                for d, (dx, dy) in enumerate(((0, -1), (1, 0), (0, 1), (-1, 0))):
                    nx, ny = x + dx, y + dy
                    if not (0 <= nx < self.w and 0 <= ny < self.h): continue
                    t = self.shape[ny][nx]
                    if t == 0 or d not in (1, 2): continue
                    a = 2 * self.elev[y][x] + EDGES[s][d]
                    b = 2 * self.elev[ny][nx] + EDGES[t][(d + 2) % 4]
                    if a != b: out.append(f"({x},{y})->({nx},{ny}) {a - b:+d}")
        return out

    def rows(self, grid):
        return [" ".join(".." if v == 0 else f"{v:02X}" for v in row) for row in grid]

    def write(self):
        d = {"name": self.name, "about": self.about, "w": self.w, "h": self.h,
             "shape": self.rows(self.shape), "elev": self.rows(self.elev),
             "walls": self.rows(self.walls), "tile": self.rows(self.tile)}
        path = os.path.join(OUT, f"{self.name}.course.json")
        with open(path, "w") as f:
            json.dump(d, f, indent=2)
            f.write("\n")
        print(self.name, "mismatched edges:", self.mismatches() or "none")


holes = []

# t1: flat, fenced; three enemies; the event-timeline test's hole
h = Hole("t1-flat", "Flat ground with walls all round: the tee, three enemies, the cup and holing; the hole of the event-timeline test.", 10, 8)
h.fence()
h.put(1, 3, tile=0x0C)
h.put(4, 1, tile=0x40)
h.put(6, 5, tile=0x4A)
h.put(8, 2, tile=0x4B)
holes.append(h)

# t2: the cardinal ramps, the faceted corners (both halves), a mound and a dimple
h = Hole("t2-ramps", "A hill (ramps $04-$07, faceted lower corners $0C-$0F), a hollow (the same ramps turned round, faceted upper corners $08-$0B), a mound $02 and a dimple $03.", 14, 10)
h.hill(3, 4)
h.pit(10, 4)
h.put(6, 8, shape=0x02, elev=1)   # mound: edges 0 at elev 1 = the flat's 2
h.put(3, 8, shape=0x03)          # dimple: edges like flat
h.fence()
h.put(1, 1, tile=0x0C)
h.put(6, 2, tile=0x4C)
h.put(10, 4, tile=0x40)
h.put(12, 8, tile=0x4B)
holes.append(h)

# t3: the diagonal halves (both), the full diagonal ramps as a 2x2 crown
h = Hole("t3-diagonals", "A hill with diagonal lower corners $14-$17, a hollow with diagonal upper corners $10-$13, and a crown of full diagonal ramps $18-$1B (its rim is half a step proud: steps).", 14, 10)
h.hill(3, 4, diagonal=True)
h.pit(10, 4, diagonal=True)
h.put(6, 7, shape=0x1B)  # TL rises E and S
h.put(7, 7, shape=0x18)  # TR rises W and S
h.put(6, 8, shape=0x1A)  # BL rises N and E
h.put(7, 8, shape=0x19)  # BR rises N and W
h.fence()
h.put(1, 1, tile=0x0C)
h.put(3, 8, tile=0x40)
h.put(12, 8, tile=0x4C)
h.put(10, 4, tile=0x4A)
holes.append(h)

# t4: terraces with steps up (blocked) and down (a launch), a fence of wall flags
h = Hole("t4-steps-walls", "Three terraces (elevations 0, 1, 3): steps up block the ball, steps down launch it; a fence of layer-4 wall flags across the middle with a gap in it.", 12, 10)
h.rect(0, 0, 11, 3, elev=0)
h.rect(0, 4, 11, 6, elev=1)
h.rect(0, 7, 11, 9, elev=3)
h.put(10, 4, shape=0x04, elev=1)  # a ramp from terrace 0 up to terrace 1
h.put(2, 6, shape=0x04, elev=2)   # two ramps from terrace 1 up to terrace 3
h.put(2, 7, shape=0x04, elev=3)
for x in range(0, 12):
    if x in (5, 6): continue
    h.put(x, 5, walls=0x04)       # S wall of row 5
    h.put(x, 6, walls=0x01)       # N wall of row 6
h.fence()
h.put(2, 1, tile=0x0C)
h.put(9, 2, tile=0x40)
h.put(3, 8, tile=0x4C)
h.put(9, 8, tile=0x4B)
holes.append(h)

# t5: two islands; falling between them loses the ball
h = Hole("t5-islands", "Two islands with a gap between them and open edges (no walls): a ball that falls off is lost and comes back to the shot's origin.", 12, 9)
h.gap(5, 0, 6, 8)
h.put(2, 4, tile=0x0C)
h.put(3, 1, tile=0x40)
h.put(9, 2, tile=0x4C)
h.put(9, 7, tile=0x4A)
holes.append(h)

# t6: the surface tiles
h = Hole("t6-surfaces", "Surface tiles: friction $20-$23 on ramps and $24 on flat, rough $04, boost panels $30-$33 (flat) and $34/$36/$38/$3A (on their ramps), kickers $10-$13, snaps $18-$1B, arrow panels $14-$17, a warp pair $B1/$B3 (the ball comes out heading E/W).", 16, 10)
h.fence()
h.put(1, 1, tile=0x0C)
for i, t in enumerate((0x30, 0x31, 0x32, 0x33)):
    h.put(3 + i, 1, tile=t)
for i, t in enumerate((0x10, 0x11, 0x12, 0x13)):
    h.put(3 + i, 3, tile=t)
for i, t in enumerate((0x18, 0x19, 0x1A, 0x1B)):
    h.put(3 + i, 5, tile=t)
for i, t in enumerate((0x14, 0x15, 0x16, 0x17)):   # the arrows, N E S W
    h.put(3 + i, 7, tile=t)
h.put(1, 5, tile=0xB1)    # a warp pair: into (9,5), out of (1,5) heading E
h.put(9, 5, tile=0xB3)    # into (1,5), out of (9,5) heading W
h.put(8, 1, tile=0x24)
h.put(9, 1, tile=0x04)
h.put(10, 1, tile=0x04)
# a hill whose ramps carry friction and boost tiles
h.hill(12, 5)
h.put(12, 4, tile=0x20)   # on $04
h.put(13, 5, tile=0x21)   # on $05
h.put(12, 6, tile=0x22)   # on $06
h.put(11, 5, tile=0x23)   # on $07
h.hill(12, 2)
h.put(12, 1, tile=0x34)   # $34 on $04 (uphill = S)
h.put(13, 2, tile=0x36)   # $36 on $05
h.put(12, 3, tile=0x38)   # $38 on $06
h.put(11, 2, tile=0x3A)   # $3A on $07
h.put(2, 8, tile=0x40)
h.put(8, 7, tile=0x4C)
h.put(14, 8, tile=0x4B)
holes.append(h)

# t7: hazards and pillars (filled in with the hazard port)
h = Hole("t7-hazards", "Hazards: bumpers $80 (actor 76) and $98-$A1 shapes, $90 (actor 77), $AC/$AD/$AE (actors 81-83), the $05 hazard, $A2; and pillars $02 (the trees).", 14, 10)
h.fence()
h.put(1, 4, tile=0x0C)
h.put(4, 2, tile=0x80)
h.put(4, 6, tile=0x98)
h.put(6, 4, tile=0x90)
h.put(8, 2, tile=0xAC)
h.put(8, 4, tile=0xAD)
h.put(8, 6, tile=0xAE)
h.put(10, 4, tile=0x05)
h.put(11, 7, tile=0xA2)
h.put(3, 8, tile=0x02)
h.put(6, 1, tile=0x02)
h.put(12, 1, tile=0x40)
h.put(12, 8, tile=0x4C)
h.put(6, 8, tile=0x4B)
holes.append(h)

# t8: an outline-wall enclosure and hovering enemies
h = Hole("t8-outline", "An octagon of play-area outline walls ($28-$2D, as on course 1 hole 1) and hovering enemies ($4D hovers 3 steps, $50 4, $51 2): the cup's reveal with the hover drop.", 12, 12)
outline = {
    (5, 1): 0x2C, (6, 1): 0x29, (7, 1): 0x29, (8, 1): 0x29, (9, 1): 0x2B,
    (4, 2): 0x2C, (5, 2): 0x2A, (9, 2): 0x2D, (10, 2): 0x2B,
    (4, 3): 0x28, (10, 3): 0x28,
    (4, 4): 0x28, (10, 4): 0x28,
    (4, 5): 0x2D, (5, 5): 0x2B, (9, 5): 0x2C, (10, 5): 0x2A,
    (5, 6): 0x2D, (6, 6): 0x2B, (8, 6): 0x2C, (9, 6): 0x2A,
    (6, 7): 0x2D, (7, 7): 0x29, (8, 7): 0x2A,
}
for (x, y), t in outline.items():
    h.put(x, y, tile=t)
h.fence()
h.put(6, 3, tile=0x0C)
h.put(8, 3, tile=0x4D)
h.put(6, 5, tile=0x50)
h.put(8, 5, tile=0x51)
holes.append(h)

for h in holes:
    h.write()
