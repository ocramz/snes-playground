/**
 * The save's rules (core/save.ts; port_v2 phase 7) against the game's own
 * battery RAM: tools/snesstep/autoplay.py's runs leave `sram.bin`, which
 * tools/sram.py decodes into the engine's JSON (build/engine/rom-test/
 * save_<run>.json, `make engine-traces`). Each run is replayed through the
 * rules from an empty save: a new member, the map's flags, every course it
 * started (`beginCourse`) and finished (`finishCourse` with the card the
 * game ranked); the result must equal the game's, member and rankings.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { RomRules } from '../src/core/rules';
import {
  emptySave, newMember, beginCourse, finishCourse, medalFor, insertRanking, rankingView, setMemberFlag, type SaveData,
} from '../src/core/save';
import { haveRules, loadTables, romTestPath } from './fixtures';

const RUNS = ['course1', 'game', 'game2', 'game4', 'extra'];

function load(run: string): SaveData | null {
  const p = romTestPath(`save_${run}.json`);
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as SaveData) : null;
}

describe.skipIf(!haveRules)('the save', () => {
  const rules = haveRules ? new RomRules(loadTables()) : (null as unknown as RomRules);

  for (const run of RUNS) {
    const want = load(run);
    it.skipIf(!want)(`replays autoplay's ${run} to the game's save`, () => {
      const g = want!;
      const gm = g.members[0]!;
      const save = emptySave();
      expect(newMember(save)).toBe(0);
      for (const bit of [1, 2]) if (gm.flags & bit) setMemberFlag(save, 0, bit);
      for (let c = 0; c < 16; c++) {
        if (gm.courses[c].rounds === 0) continue;
        beginCourse(save, 0, c);
        const rec = g.rankings[c].find((r) => r.member === 0);
        if (rec) finishCourse(save, rules, 0, c, rec.holes);
      }
      expect(save.members[0]).toEqual(gm);
      expect(save.members.slice(1)).toEqual(g.members.slice(1));
      expect(save.serial).toBe(g.serial);
      expect(save.rankings).toEqual(g.rankings);
    });
  }

  it("medalFor: course 1's thresholds 26 / 19 / 14 ($81:C735)", () => {
    expect([27, 26, 20, 19, 15, 14, 8].map((s) => medalFor(rules, 0, s))).toEqual([0, 1, 1, 2, 2, 3, 3]);
  });

  it('the ranking: the built-in rows, a new record placed after its equals, the 25th kept out', () => {
    const save = emptySave();
    newMember(save);
    const view = rankingView(save, rules, 0);
    expect(view.map((r) => [r.member, r.score, r.rounds])).toEqual([[5, 19, 5], [6, 23, 8], [7, 27, 12], [8, 31, 13], [9, 35, 17]]);
    // a 19 in 5 rounds ties the built-in 19 in 5: the new record's id 25 sorts before the built-ins' 40-44
    expect(insertRanking(save, rules, 0, { member: 0, score: 19, rounds: 5, holes: [2, 3, 3, 2, 2, 2, 2, 3] })).toBe(0);
    expect(insertRanking(save, rules, 0, { member: 0, score: 19, rounds: 5, holes: [2, 3, 3, 2, 2, 2, 2, 3] })).toBe(1);
    for (let k = 0; k < 23; k++) insertRanking(save, rules, 0, { member: 0, score: 40 + k, rounds: 1, holes: [5, 5, 5, 5, 5, 5, 5, 5] });
    expect(save.rankings[0].length).toBe(25);
    expect(insertRanking(save, rules, 0, { member: 0, score: 99, rounds: 1, holes: [] })).toBe(-1);
    expect(insertRanking(save, rules, 0, { member: 0, score: 8, rounds: 2, holes: [1, 1, 1, 1, 1, 1, 1, 1] })).toBe(0);
    expect(save.rankings[0].length).toBe(25);
    expect(save.rankings[0][0].score).toBe(8);
  });
});
