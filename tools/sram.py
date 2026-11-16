#!/usr/bin/env python3
"""The game's battery RAM (8 KB at $70:0000) as the engine's save JSON
(port_v2 phase 7; docs/save.md).

    python3 tools/sram.py build/emu/autoplay/course1/sram.bin           # print it
    python3 tools/sram.py build/emu/autoplay/course1/sram.bin -o x.json

The fields, read from the routines that write them (docs/save.md):
- $70:0010 + 2m   member m's cleared courses, $9999 = no member ($81:FA58)
- $70:001A + 2m   its flags (bit 0 the map seen, bit 2 the 8 courses, bit 3 the extra 8)
- $70:0024 + 2m   its serial ($70:1B3C at its creation, $81:FA9F)
- $70:0218 + 64m + 4c   course c's rounds ($81:C52D), +2 its medal 0-3 ($81:C6A5)
- $70:0358 + 350c + 14k  course c's ranking record k: the member, the score, the
                  rounds, an order byte, the 8 holes' strokes; an empty
                  record's first word is $4444 ($81:CA34)
- $70:1B3C        the next serial
The checksums ($70:020E, $81:C4B7), the drawings ($70:002E), the ranking's
merged order ($70:1958) and the order bytes are not kept: the engine's JSON
has no checksum, its drawings are blank, and the order follows from the
records (core/save.ts rankingView).
"""
import argparse
import json
import sys

COURSES, MEMBERS, RECORDS = 16, 5, 25


def w(b, a):
    return b[a] | (b[a + 1] << 8)


def decode(b):
    members = []
    for m in range(MEMBERS):
        cleared = w(b, 0x10 + 2 * m)
        if cleared == 0x9999:
            members.append(None)
            continue
        base = 0x218 + 64 * m
        members.append({
            "cleared": cleared,
            "flags": w(b, 0x1A + 2 * m),
            "serial": w(b, 0x24 + 2 * m),
            "courses": [{"rounds": w(b, base + 4 * c), "medal": w(b, base + 4 * c + 2) & 3}
                        for c in range(COURSES)],
        })
    rankings = []
    for c in range(COURSES):
        recs = []
        for k in range(RECORDS):
            o = 0x358 + 350 * c + 14 * k
            if w(b, o) == 0x4444:
                continue
            recs.append({"member": b[o], "score": w(b, o + 1), "rounds": w(b, o + 3),
                         "holes": list(b[o + 6:o + 14])})
        rankings.append(recs)
    return {"version": 1, "members": members, "serial": w(b, 0x1B3C), "rankings": rankings}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("sram")
    ap.add_argument("-o", "--out")
    args = ap.parse_args()
    data = decode(open(args.sram, "rb").read())
    text = json.dumps(data, separators=(",", ":"))
    if args.out:
        with open(args.out, "w") as f:
            f.write(text)
    else:
        print(json.dumps(data, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
