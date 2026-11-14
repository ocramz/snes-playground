/**
 * The architecture rule (plans/port_v1_koota_phaser4.md): Koota owns state
 * and rules, Phaser is the platform, and only the bridge touches both — so
 * nothing under src/core may import Phaser. Checked statically so the rule
 * holds from the first commit, before there is any core code to speak of.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = fileURLToPath(new URL('.', import.meta.url));
const core = resolve(here, '../src/core');

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = resolve(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (/\.[cm]?[jt]s$/.test(name)) yield path;
  }
}

describe('src/core imports koota only', () => {
  // import/export-from/require of the phaser package; mentions in comments
  // (e.g. "the Phaser host") are fine and expected.
  const use = /(?:import\s[^'"]*|export\s[^'"]*from\s*|require\()\s*['"]phaser(?:\/[^'"]*)?['"]/;
  it('no file under src/core imports phaser', () => {
    const offenders: string[] = [];
    for (const path of walk(core)) {
      if (use.test(readFileSync(path, 'utf8'))) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });
});
