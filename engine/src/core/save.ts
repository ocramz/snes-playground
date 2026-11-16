/**
 * The save (port_v2 phase 7; docs/save.md): the game's battery RAM as the
 * engine's own JSON (the user's choice, 2026-11-16), and the rules that
 * write it, read from the game's routines. tools/sram.py decodes the game's
 * `sram.bin` into the same shape, so the tests compare the two.
 *
 * Not kept: the checksums (`$70:020E`, `$81:C4B7`), the members' drawings
 * (NAME ENTRY is skipped: every drawing is blank), the ranking's merged
 * order `$70:1958` and the records' order bytes (rankingView derives them).
 */
import type { RomRules } from './rules';

export const MEMBERS = 5;
export const COURSES = 16;
export const RANKING_RECORDS = 25;
/** `$81:C546`: the rounds stop at 999. */
export const ROUNDS_MAX = 999;
/** `$81:C672`: a hole's strokes count at most 99 on the card and in the score. */
export const HOLE_MAX = 99;

export interface CourseSave {
  /** `$70:0218` + 64 m + 4 c: the times the course was started ($81:C52D). */
  rounds: number;
  /** `$70:021A` + 64 m + 4 c: the best medal, 0 none, 1 bronze, 2 silver, 3 gold. */
  medal: number;
}

export interface MemberSave {
  /** `$70:0010` + 2 m: the next course to clear, 0-8 (15 in the extra game). */
  cleared: number;
  /**
   * `$70:001A` + 2 m: bit 0 the map seen ($83:9845), bit 1 the extra map's,
   * bit 2 the eight courses cleared, bit 3 the extra eight ($81:C6D4, $81:C6FE).
   */
  flags: number;
  /** `$70:0024` + 2 m: the member's serial, `$70:1B3C` at its creation. */
  serial: number;
  courses: CourseSave[];
}

export interface RankingRecord {
  /** 0-4 a member; the built-in records are 5-9. */
  member: number;
  /** The course's total strokes. */
  score: number;
  /** The member's rounds of the course when it was played. */
  rounds: number;
  holes: number[];
}

export interface SaveData {
  version: 1;
  members: Array<MemberSave | null>;
  /** `$70:1B3C`: the next member's serial. */
  serial: number;
  /** By course: the saved records, best first (at most 25). */
  rankings: RankingRecord[][];
}

export function emptySave(): SaveData {
  return {
    version: 1,
    members: Array.from({ length: MEMBERS }, () => null),
    serial: 1, // $81:C43D: a fresh save's $70:1B3C
    rankings: Array.from({ length: COURSES }, () => []),
  };
}

/**
 * `$81:FA49`, NEW MEMBER: the first empty slot (`$9999`), cleared 0, the
 * serial `$70:1B3C` (then + 1); -1 when all five are taken (`$70:1B38` ≥ 5).
 * The drawing (`$70:002E`) is cleared, and NAME ENTRY (`$81:E0E1`) is skipped.
 */
export function newMember(save: SaveData): number {
  const m = save.members.findIndex((x) => x === null);
  if (m < 0) return -1;
  save.members[m] = {
    cleared: 0,
    flags: 0,
    serial: save.serial,
    courses: Array.from({ length: COURSES }, () => ({ rounds: 0, medal: 0 })),
  };
  save.serial += 1;
  return m;
}

/** `$83:9845`: set a member's flag bit once; true when it was not set (the map plays its one-time advance). */
export function setMemberFlag(save: SaveData, m: number, bit: number): boolean {
  const mem = save.members[m];
  if (!mem || (mem.flags & bit) !== 0) return false;
  mem.flags |= bit;
  return true;
}

/** `$81:C52D`, at a course's intro: its rounds + 1, up to 999. */
export function beginCourse(save: SaveData, m: number, course: number): void {
  const c = save.members[m]?.courses[course];
  if (c && c.rounds + 1 < ROUNDS_MAX + 1) c.rounds += 1;
}

/** `$81:C775`: the medal is how many of the course's thresholds (`$81:C735` + 4 c) are ≥ the score. */
export function medalFor(rules: RomRules, course: number, score: number): number {
  const t = rules.table('medalThresholds');
  let n = 0;
  for (let k = 0; k < 4; k++) {
    const v = t[course * 4 + k];
    if (v === 0 || v < score) break;
    n += 1;
  }
  return n;
}

/** What `$81:C666` leaves in `$EC4B` and beside it, for the shell's screens. */
export interface CourseResult {
  /** `$D7E0`: the total strokes (each hole at most 99). */
  score: number;
  /** The medal of this round. */
  medal: number;
  /** `$EC4B` bit 0: a better medal was stored. */
  newMedal: boolean;
  /** `$EC4B` bit 1: the member's next course moved on. */
  advanced: boolean;
  /** `$EC4B` bits 1-2 together: the eight (or the extra eight) courses are now all cleared. */
  allCleared: boolean;
  /** `$EC4B` bit 3: the round entered the ranking. */
  ranked: boolean;
  /** `$EC4D`: its place among the course's merged records (saved and built-in), or -1. */
  place: number;
}

/**
 * `$81:C666`, at the last hole's hole-out (1P): the card's holes capped at
 * 99 and summed; the medal stored when better; the cleared count moved on
 * when this was the member's next course (at 8 the flag bit 2 instead, at
 * 16 bit 3 and the count stays); the ranking's insertion (`$81:C8C6`).
 */
export function finishCourse(save: SaveData, rules: RomRules, m: number, course: number, card: number[]): CourseResult {
  const mem = save.members[m];
  const holes = card.slice(0, 8).map((n) => Math.max(0, Math.min(HOLE_MAX, n)));
  while (holes.length < 8) holes.push(0);
  const score = holes.reduce((a, b) => a + b, 0);
  const medal = medalFor(rules, course, score);
  const out: CourseResult = { score, medal, newMedal: false, advanced: false, allCleared: false, ranked: false, place: -1 };
  if (!mem) return out;
  const c = mem.courses[course];
  if (c.medal < medal) {
    c.medal = medal;
    out.newMedal = true;
  }
  if (mem.cleared === course) {
    const next = mem.cleared + 1;
    if (next >= 16) {
      if ((mem.flags & 8) === 0) {
        mem.flags |= 8;
        out.advanced = out.allCleared = true;
      }
    } else if (next === 8) {
      if ((mem.flags & 4) === 0) {
        mem.cleared = 8;
        mem.flags |= 4;
        out.advanced = out.allCleared = true;
      }
    } else {
      mem.cleared = next;
      out.advanced = true;
    }
  }
  const r = insertRanking(save, rules, course, { member: m, score, rounds: c.rounds, holes });
  out.ranked = r >= 0;
  out.place = r;
  return out;
}

/** The order the game sorts the merged records in: score, then rounds, then the record's id. */
function before(a: { score: number; rounds: number; id: number }, b: { score: number; rounds: number; id: number }): boolean {
  if (a.score !== b.score) return a.score < b.score;
  if (a.rounds !== b.rounds) return a.rounds < b.rounds;
  return a.id < b.id;
}

/** The ROM's five built-in records of a course (`$81:CAB7`; their ids 40-44). */
export function builtinRecords(rules: RomRules, course: number): Array<RankingRecord & { id: number }> {
  const t = rules.table('rankingBuiltins');
  const out: Array<RankingRecord & { id: number }> = [];
  for (let k = 0; k < 5; k++) {
    const o = (course * 5 + k) * 12;
    out.push({
      member: t[o], score: t[o + 1], rounds: t[o + 2], id: t[o + 3],
      holes: Array.from(t.slice(o + 4, o + 12)),
    });
  }
  return out;
}

/**
 * `$81:C8C6`: a round enters a course's ranking when it beats the 25th
 * saved record (by score, then rounds; an empty slot always loses). The 24
 * best saved, the new one (id 25, so after its equals) and the 5 built-in
 * records are sorted together; the members' records go back in that order.
 * Returns the new record's place in the merged order (`$EC4D`), or -1.
 */
export function insertRanking(save: SaveData, rules: RomRules, course: number, rec: RankingRecord): number {
  const saved = save.rankings[course];
  const last = saved[RANKING_RECORDS - 1];
  if (last && !(rec.score < last.score || (rec.score === last.score && rec.rounds < last.rounds))) return -1;
  const merged = mergedRanking([...saved.slice(0, RANKING_RECORDS - 1), rec], rules, course, saved.length >= RANKING_RECORDS ? 24 : saved.length);
  save.rankings[course] = merged.filter((x) => x.member < MEMBERS).map(({ member, score, rounds, holes }) => ({ member, score, rounds, holes }));
  return merged.findIndex((x) => x.id === 25);
}

/** The merged order: saved records (ids 0..), the record at `newAt` id 25, the built-ins 40-44. */
function mergedRanking(saved: RankingRecord[], rules: RomRules, course: number, newAt = -1): Array<RankingRecord & { id: number }> {
  const all = [
    ...saved.map((r, i) => ({ ...r, id: i === newAt ? 25 : i })),
    ...builtinRecords(rules, course),
  ];
  // the game's exchange sort ($81:C9A9) over 30 places; a stable order by the key gives the same
  return all.sort((a, b) => (before(a, b) ? -1 : before(b, a) ? 1 : 0));
}

/** The course's ranking as the screens show it: the saved and built-in records merged, best first. */
export function rankingView(save: SaveData, rules: RomRules, course: number): RankingRecord[] {
  return mergedRanking(save.rankings[course], rules, course).map(({ member, score, rounds, holes }) => ({ member, score, rounds, holes }));
}
