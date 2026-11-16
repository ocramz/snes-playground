/**
 * The per-hole RESULT card (`$83:D3ED`; port_v2 phase 7) against
 * tools/snesstep/inputs/web_card.txt: web_hole's hole 1 played out, then the
 * card's blank, its fade in, the wait for a held A, B or Start (A at 4560),
 * the fade out and the blank until the next hole's load (4640). Course 1's
 * holes 1 and 2, so the hole is not the course's last.
 */
import { describe, expect, it } from 'vitest';
import { runFlowScript, GAME_OFFSET } from './flow-harness';
import { matchChanges, type FlowEvent } from './align';
import { haveRules, haveRomTest, loadFlow } from './fixtures';
import { HoleFlow } from '../src/core/traits/flow';

const lowByte = (events: FlowEvent[]): FlowEvent[] =>
  events.map((e) => (e[1] === 'bright' ? [e[0], e[1], Number(e[2]) & 0xff, ...e.slice(3)] as FlowEvent : e));

describe.skipIf(!haveRules || !haveRomTest)('the RESULT card vs the recorded game', () => {
  const want = loadFlow('web_card');
  describe.skipIf(!want)('web_card', () => {
    const run = want ? runFlowScript('web_card', 4650 - GAME_OFFSET, { more: [1] }) : null;
    it('the brightness from the card to the next hole', () => {
      expect(matchChanges(lowByte(want!.events), run!.events, 'bright', 4331, 4639)).toBeNull();
    });
    // (the game clears holed at 4578, in the next hole's load: the host's nextHole here)
    for (const field of ['card0', 'holed', 'panel', 'hudon']) {
      it(field, () => {
        expect(matchChanges(want!.events, run!.events, field, 2333, 4575)).toBeNull();
      });
    }
    it('ends at the next hole, after the press', () => {
      const phases = run!.phases.filter(([, p], i, a) => i === 0 || a[i - 1][1] !== p);
      const at = (p: string): number => phases.find(([, q]) => q === p)?.[0] ?? -1;
      expect(Math.abs(at('Card') - 4331)).toBeLessThanOrEqual(2);
      expect(Math.abs(at('HoleOver') - 4640)).toBeLessThanOrEqual(2);
      expect(run!.world.get(HoleFlow)!.phase).toBe('HoleOver');
    });
  });
});
