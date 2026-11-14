/**
 * The trigonometry the kernels read: sub_sin_deg $80:A4BA and
 * sub_cos_deg $80:A4B3 index tbl_sin_deg $80:A5A2 (450 words, 0-449°, the
 * cosine read 90° along). Pure lookups.
 */
import type { RomRules } from '../rules';

export function sinDeg(rules: RomRules, deg: number): number {
  return rules.table('sinDeg')[deg];
}

export function cosDeg(rules: RomRules, deg: number): number {
  return rules.table('sinDeg')[(deg + 90) % 450];
}

export function cosSinDeg(rules: RomRules, deg: number): { cos: number; sin: number } {
  return { cos: cosDeg(rules, deg), sin: sinDeg(rules, deg) };
}
