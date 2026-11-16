/**
 * The per-hole RESULT card's content (pure; port_v2 phase 7, `$83:D3ED`):
 * which course's window, the strokes of the holes played so far
 * (`$83:CFF7`: the card `$D80A`, one number per hole up to the current one,
 * a star beside a 1), the total `$D7E0`, and the screen's brightness.
 */
import type { World } from 'koota';
import { HoleFlow } from '../../../core/traits/flow';
import { Career } from '../../../core/traits/counters';
import { Session } from '../../../core/traits/session';
import { Screen } from '../../../core/traits/screen';
import { AimUi } from '../../../core/traits/aim-ui';
import { Time } from '../../../core/traits/time';
import { Save } from '../../../core/traits/save';
import { rankingView } from '../../../core/save';

export interface CardState {
  visible: boolean;
  /** SELECT's card: the course's best record beside the strokes so far ($83:C8DD). */
  best: { strokes: number[]; total: number } | null;
  /** The strokes of holes 0..n (the card's entries that are set). */
  strokes: number[];
  total: number;
  /** 0-15; -1 for the forced blank. */
  bright: number;
}

export const NO_CARD: CardState = { visible: false, best: null, strokes: [], total: 0, bright: 15 };

export function cardState(world: World): CardState {
  const flow = world.get(HoleFlow)!;
  const ui = world.get(AimUi)!;
  if (flow.phase === 'Aim' && ui.cardAt !== 0) return selectCard(world, ui);
  if (flow.phase !== 'Card') return NO_CARD;
  const s = world.get(Session)!;
  const card = world.get(Career)!.card;
  const strokes: number[] = [];
  for (let k = 0; k <= s.holeIndex && k < card.length; k++) strokes.push(Math.max(0, Math.min(99, card[k])));
  const scr = world.get(Screen)!;
  return {
    visible: true,
    best: null,
    strokes,
    total: strokes.reduce((a, b) => a + b, 0),
    bright: scr.blank ? -1 : scr.bright,
  };
}

/**
 * SELECT's card, up from the blank at S + 16 to the hole's return at P + 26
 * (core/systems/aim-ui.ts scorecard): the holes finished so far (`$83:CFB6`
 * with `$6A5E`) and the course's best record (`$70:1958`'s first, a saved
 * or a built-in one: core/save.ts rankingView).
 */
function selectCard(world: World, ui: { cardAt: number; cardPress: number }): CardState {
  const f = world.get(Time)!.frame;
  const up = ui.cardPress === 0 ? f - ui.cardAt >= 16 : f - ui.cardPress < 26;
  if (!up) return NO_CARD;
  const s = world.get(Session)!;
  const card = world.get(Career)!.card;
  const strokes: number[] = [];
  for (let k = 0; k < s.holeIndex && k < card.length; k++) strokes.push(Math.max(0, Math.min(99, card[k])));
  const save = world.get(Save)!;
  const rules = s.rules;
  const best = rules && s.course >= 0 ? rankingView(save.data, rules, s.course)[0] : null;
  const scr = world.get(Screen)!;
  return {
    visible: true,
    best: best ? { strokes: best.holes, total: best.score } : { strokes: [], total: 0 },
    strokes,
    total: strokes.reduce((a, b) => a + b, 0),
    bright: scr.blank ? -1 : scr.bright,
  };
}

/**
 * `$83:D081`'s number at the slot (x, y): its digits' cells in card_digits.png
 * (cell k is the digit k + 1, cell 9 the 0), right to left 9 px apart, the
 * units' top tile at (x - 4, y - 8).
 */
export function numberCells(n: number, x: number, y: number): Array<{ cell: number; x: number; y: number }> {
  const out: Array<{ cell: number; x: number; y: number }> = [];
  let v = Math.max(0, n);
  let cx = x - 4;
  do {
    const d = v % 10;
    out.push({ cell: d === 0 ? 9 : d - 1, x: cx, y: y - 8 });
    v = Math.floor(v / 10);
    cx -= 9;
  } while (v > 0);
  return out;
}
