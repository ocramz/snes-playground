# Engine phase 4: the ball kernels

Date: 2026-11-14 (session 3). Plan: `plans/port_v1_koota_phaser4.md` item 4 —
"Ball kernels plus `BALL_STEP` plus the stall runner, against the 11
`trace_web_*` shots seeded at launch".

**Result: all 11 trace tests pass** (`engine/test/trace-shots.test.ts`,
frame-exact from the launch seed to the ball-lost reset). Full suite: 85
tests, `tsc --noEmit` clean, `vite build` clean, `make engine-test` green.

## What was built

| Engine artefact | Original routine |
|---|---|
| `src/core/sim/probe.ts` | sub_terrain_probe $81:9479 (+ the $82:C85F overlay wrapper's $D9EE flag) |
| `src/core/sim/move.ts` | $81:8805 integrate, $81:885C drag, $81:899F gravity, $81:89AA fall |
| `src/core/sim/reflect.ts` | $81:8E60 heading, $81:9444 matrix load, $81:8DAF sub_reflect |
| `src/core/sim/edges.ts` | $81:9001 cross, $81:925E step height, $81:92AC wall flags, $81:9286 cross product |
| `src/core/sim/landing.ts` | $81:8905-$81:89A9 landing, $81:8CE2 spin impulse, $81:8C79/$81:8C48 hit-stop requests |
| `src/core/sim/roll.ts` | $81:8A56 rolling, $81:980B crest stub, $81:8A81 friction, $81:8AE1 slope, $81:8D17 curve, $81:80C5 class index |
| `src/core/sim/wall-step.ts` | $81:9390 wall, $81:93D1 step, $81:87B2/$81:87CA restore, $81:8B78 launch |
| `src/core/sim/outline.ts` | $82:9019 outline wall + $82:92C2 line side |
| `src/core/sim/dispatch.ts` | $81:811B/$81:8436 tables + the tile handlers |
| `src/core/sim/cup.ts` | $82:AD8E/$82:AD36/$82:AFE9/$82:B048/$82:AF09/$82:AF51 |
| `src/core/sim/enemy.ts` | $82:8967/$82:8990 detection (the take is phase 6) |
| `src/core/sim/shot.ts` | $81:C2E6 power, $81:BA0B launch velocity, $81:C1D5 spin |
| `src/core/sim/still.ts` | $81:A5CD still count |
| `src/core/systems/ball-step.ts` | BALL_STEP (schedule items 11-29), the stall runner, $82:F030/$82:F1E3 load/store, $82:DA51 modifier arming, $81:9BE5 tail |
| `src/core/schedule.ts`, `events.ts`, `actions.ts` (placeBall), traits | the frame, the event model, the poke action |

## The facts the trace work settled (docs candidates)

These were hit as trace divergences and fixed; each is now pinned by the
passing traces:

- **mulQ15s operand order ($81:9793).** The velocity is A, the factor X. A
  < 0 negates |A| x X after the floor, so the rounding is toward zero when
  the VELOCITY is negative — the damping `vx x $DA3C` with vx < 0 gives
  trunc, and my first port (factor as A) was 1 low. Only mulQ15s is
  asymmetric; mulFloor/mul16x8 are value-symmetric.
- **The friction clamp's two branches are opposite ($81:8AC8).** vx >= 0:
  a borrow (v_u < fx_u) zeroes the axis. vx < 0: NO borrow (the sum
  crossed zero upward) zeroes it; a borrow keeps the wrapped remainder.
  My first port had both branches clamping on sign flip.
- **Air drag branches on the signed value ($81:885C BPL).** Branching on
  the raw pattern sent every negative velocity down the positive branch
  (h computed from a ~65000 magnitude).
- **The cup fold is EOR #$FFFF only ($82:AFEC).** Not a negation: $8000
  maps to $7FFF (the table's far corner, word 1023 = the $5000 centre),
  $C000 to $3FFF. My first fold (negation) read the wrong end.
- **The step-clamp table ($81:93E2) maps edge 2 (S) to yf = $FFFF, same
  as edge 0 (N)** — my first read (from a desynced listing) had S -> 0.
  With it, both vertical crossings use edge index 2 ($81:906C-$81:9075)
  and the emulated "+y step clamps yf to 7+$FFFF" falls out.
- **The hit-dispatch ids in tables.json.** The exporter's first cut
  assigned ids per table, so hit entries pointed at land handlers; now
  both tables remap into one shared handler list (`dispatchHandlers`).
- **$6AC0 = 2 during play** ($82:C027, the shot-setup driver), so the
  outline wall always takes the presentation path: restore x/y/z
  ($82:ECD7) + probe fields ($81:87CA) + sfx 7. The silent path
  ($6AC0 = 0, restore x/y + probe + heading) is the guide's.
- **The outline wall on the LANDING dispatch ends with the gravity tail**
  ($82:9015 JML $81:899F); on the HIT dispatch it just ends the step
  (RTL). A landing-dispatch reroute with `entry: 'gravityOnly'` must NOT
  re-run the landing chain (the cup's exits are the same shape).
- **The fall-below-z-0 path ($81:89AA) applies its own gravity and ends
  the step** — select-outcome must early-return on it (`fell` route), or
  the stale $DA4C from the gap frames triggers a phantom step hit.

## Unported / stubbed (flagged, excluded from the exact tests per risk 5)

- **Crest crossing branches ($81:9831-$81:994F)**: the no-edge-crossing
  crest branch is ported ($81:980B's STZ $6A7A + code-change test with
  crestShape); the eight per-crossing-type quadrant-sample branches fall
  through to "no crest". Exact for flat/same-shape crossings.
- **Toggle tiles $70-$7B**: the gate reads the direction map at
  $88:9190 ($82:A086) — table not exported, helpers not read.
- **Overlay $60-$6F**: the enter/leave tracking ($82:80F6) is not read;
  the $D9EE flag itself is ported.
- **Hazards $80-$8F/$90-$97/$98-$A1/$A2/$AC-$AE**: the actor-box tests
  walk the enemy list ($82:997E/$82:9ABF/$82:E701) — needs phase 6's
  enemy entities. The handlers return "plain ground" for now.
- **unk14/unk15/unk58/unk5a/unk5c/unkB0** (tiles $14-$17, $58-$5D,
  $B0-$B9): handlers located, not read (tiles.md "Not established").
- **Snap gate $82:A692** and the snap impulses' exact clamps: stubbed
  pending a trace that reaches them.
- **Pillar mode-7 branch ($82:EE9A)**: clears the tile from layer 2 in
  mode 7; modes are always 0 in phase 4.
- **Enemy take -> cup conversion + reveal stall**: phase 6 (the
  detection half is ported; `enemyDispatch` takes an `onTake` hook).
- **The hole-out sequence ($82:AD13)**: the physics state is set, the
  camera/song/ball-to-star replay is phase 6.
- **Rough tiles' $80:A453 arithmetic** ($82:93DA): ported with the
  unsigned 16x16 reading; unexercised by any course-1 trace.
- **$68F0** (the bounce-sfx override in $81:9BE5) treated as 0.

## Deviations (for docs/engine.md)

- The coefficients ($DA30-$DA46) live in the work copy only; the block
  round-trips them in the ROM but nothing in phase 4 needs the block
  copies (single ball). One-line change in load/store when 2P lands.
- The outline wall's sfx 7 is queued through tailSfx and emitted by the
  step tail, where the ROM plays it inline — same frame, same id.
- The hit-stop's pad merge: the runner ORs the pad into a latch per
  stall frame and merges into held/prev at expiry (the ROM's
  $6A7C/$6A7E -> $0067/$006B). Pressed edges during a stall are lost,
  as in the ROM.
- `placeBall` optionally re-probes so a fresh placement has current
  probe fields (the ROM's block carries them at $D8C2-$D8DE; a poke
  that skips them makes the first step's z read the stale ground).

## Harness notes

- The trace comparison runs one core frame per record with up to 11
  extra frames (the game's lag bursts), and frames while a stall is
  active don't consume the budget; the loop stops at `lost` (the game's
  tee reset is flow, not physics).
- A/Y presses inject at the web-calibrated stamps (3022 / 3202).

## For phase 5/6

- The stall runner's cupReveal kind is defined and unused.
- `Modifier` arming emits sfx $26; the Kirby pose change ($D7D4 = $0D)
  is phase 5.
- The guide reuses the same kernels silently (no events) — the emit
  path is behind the systems, so this already holds.
