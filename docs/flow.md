# The turn and the hole: the game's flow in play

This doc covers the 1-player game around one hole:
- a turn, from the shot's set-up through the aim loop, the shot thread (the pan, the panel, the spin and power stages, the launch), the roll and its end, to the next set-up;
- the hole, from its start to the RESULT card, with the tomatoes, the lives and the strokes;
- the hole-out.

The ball's own physics is [physics.md](physics.md), and the screens around a hole are [emulation.md](emulation.md) "The game's top-level flow".

**Where the facts come from.** Almost everything here was read from the disassembly for the engine port (2026-11-14; listings in `build/engine/disasm/`). Each fact is pinned by a test that compares the engine with a stepper recording:
- `tools/snesstep/trace_flow.py` records per frame Kirby's state, the aim, the camera, the meter and the counters;
- the stepper's log of every sound request (`$80:B542`, `$80:B4AC`);
- the ball traces.

The tests are `engine/test/flow.test.ts`, `events.test.ts` and `trace-script.test.ts` ([engine.md](engine.md) "Verification"). A run is named by its input script (`tools/snesstep/inputs/web_*.txt`, all on course 1 hole 1 unless noted). Frame numbers are the game's main-loop iterations (emulation.md "Frames, iterations and snapshots").

## The hole loop

The hole is one straight line of native code, `$80:F278`-`$80:F48C`, and each of its parts blocks until it is done:

| part | routine | ends |
|---|---|---|
| the turn top | `$80:F278` | the set-up, or the tired pose first |
| the set-up | `$80:F73B`, `$80:C4FF`, `$80:C5F1` | the aim loop |
| the aim loop | `$81:A619`, `$81:A680`-`$81:A80A` | the A press |
| the shot thread | `$81:BE91`-`$81:C0EC` | the roll's start |
| the roll loop | `$82:BFBC`, `$82:C052`- | the shot over, then the roll's end `$82:C172` |
| the shot's end | `$80:F37A` | holed `$80:F48C`, lost `$80:F830`, or settled `$80:F39F` |

## The set-up

The hole's song is requested by `$80:C967` at the hole's start (`$80:C499`;
2169 on hole 1, during the intro) and again 13 frames later. The song comes
from a per-course list by hole: on course 1, songs 11, 11, 11, 11, 7, 7, 7 and
13 ([audio.md](audio.md) "Which code plays what").

- `$80:F73B`, the turn's load, sets the elevation to `$FFFF` and puts Kirby on the ball. It writes only the integer words of his position. His fractions stay 0 until the roll's first frame ([physics.md](physics.md) "Screen projection").
- `$80:C4FF`:
  - strokes `$D82A` + 1 (`$80:C50B`, capped at 99);
  - the aim is snapped toward the target by `$80:C902`, thresholds 23, 68, …, 338. This runs at every set-up, the first one included.
- **The target** is the free enemy nearest the ball (`$82:8E41`), by the squared distance of the 8.8 positions; a tie goes to the first in the enemy list. From hole 1's tee, (8,3) and (6,5) tie and (8,3) wins (dis., stepper watch). Once the cup is revealed, the target is the cup's centre (`$82:8B5C`; physics.md "Enemies and the cup").
- `$80:C5F1` and the head of `$81:A619` follow. The aim loop starts on the set-up's fourth frame.
- `$80:C60A` stores pose 4 through an X that the calls before it leave. No flow trace shows a state change from it; the first aim iteration sets 4 or 5.
- **Tired** (`$80:C79A`): at the turn top with 1 or 2 tomatoes left, these come before the set-up's `$80:C4FF`:
  1. the turn's load;
  2. a pan toward Kirby (`$80:C8A8`: a frame, then `$81:BA8A` each frame until it arrives);
  3. pose 11;
  4. a wait of 80 frames (`$80:C7C6`), plus 36 at one tomato (`$80:C7BF`).

  web_tomatoes, two tomatoes: the load at 2863, the pose at 2873, the set-up at 2953. One tomato: 3217, 3227, 3343.

## The aim loop

Each iteration (`$81:A680`-`$81:A80A`):
1. An A press plays `$34`, and the loop returns.
2. Otherwise:
   1. the d-pad (`$81:B555`);
   2. the facing, when the aim changed (`$81:BB4A`, `$81:BCA0`; the Facing row of [web-demo.md](web-demo.md) "Measured with the stepper (not in the older docs)");
   3. a pan toward the guide's end (`$81:BA8A`);
   4. pose 5 while a direction is held, else 4;
   5. `$81:A956`: on a change, the guide again with `$6ACE` = 1 (`$81:A9B8`; physics.md "The shot guide"), then the tick `$53`.
3. In a fly shot, after 16 quiet iterations the full guide runs, with `$6ACE` = `$6ACC` = 3.

A stepper watch shows these values set at `$83:DFC0`: `$6ACC` = 3, `$6B3C` = 63 (the meter's top), `$6B5E` = 3 (the top/back step).

**The d-pad** (`$81:B555`):
- A held direction turns the aim 1° on the first call. Nothing more happens until the hold counter `$6ADE` reaches 15, and from then on it turns 3° per call. Right lowers the angle, Left raises it.
- Up (held) chooses the fly shot through the kind state `$6AD6` (0 → 2). Down (pressed) chooses the grounder.
- L and R snap the aim by 45° through `$81:B729`.

**The guide outlasts the frame.** The loop's next iteration comes later:
- rolling guide: 1 + ceil(steps / 20) frames later, so 3 for the 40 steps of every auto-repeat step of web_flow;
- fly guide on a change: 5 frames later (web_ui 2600 → 2605);
- fly shot's full guide (`$81:A9AC`): 8 frames later (web_fly and web_ui 2620 → 2627).

The tick `$53` is requested after the guide, so it sounds on the lag's last frame (`$81:A977` → `$81:A98B`). The measured "held 17 frames → 3° every 3 frames" is the hold counter plus this lag; every aim value of web_flow lands on the game's frame. Shorter rolling guides and the full fly guide's lag on other shots are unverified.

Not read for the port:
- B, the overview (`$83:B214`);
- Y, look around (`$81:B9A2`, the score panel);
- Start (`$83:AFA7`);
- the idle timer `$6AC2`.

## The shot thread `$81:BE91`

Frames are counted from the press that starts each stage; each stage's letter is the frame its count starts from.

| stage | from | frames |
|---|---|---|
| pan to the shot view | P, the aim's A | P + 5: the first pan. From P + 6, each frame first asks whether the last pan found the camera there (`$6AB0`, `$81:BEE6`), then pans again. The view is Kirby + `($81:C0F0, $81:C0F8)`[the aim's quarter] = (80, 0), (0, 40), (−80, 0), (0, −56). On arrival Kirby curls (state 6) |
| spin stage | C, the curl | C + 30: the panel's initial state, meter 0 and top/back 6 (`$81:BF41`, after the curl's yield `$1D` at `$81:BF30`); it shows on a second shot (web_hole 3697). C + 39 / C + 41: the panel shows the meter as `$FFFF`, then 0 (`$84:8FD9`, `$84:9073`). C + 42: the selectors' first frame (`$81:C12E`). From C + 43 an A press ends the stage. The selectors' steps are in physics.md "Spin" |
| power | Q, that press | Q + 4: sound `$57`. From Q + 5, each frame tests A before the meter moves (0 → 63 → 0, one step a frame), and the meter fires by itself when it is back at 0 |
| launch | R, the latch | the latch requests sound 0 twice (`$81:C038`, `$81:C046`). R + 1: the power and the spin (`$81:C2E6`, `$81:C1D5`). R + 22: the roll's start, `$82:BFBC` (below). R + 24: the first physics step |

The roll's start, `$82:BFBC`:
- it sets the camera's follow lag to the view's offset (`$38C6/$38C8`);
- it queues a tomato −1 (`$82:BFD8`, `$83:ABC5`): every shot costs one;
- it spawns the spin streak, object 25 (`$82:BFE9`). In a fly shot that sets `$68F0` from `$84:89D0`[the latched spin's distance from 6, at most 6], which makes the first bounce's sound `$68F0` + 4 (web_fly 3109: sound 6; [physics.md](physics.md) "The two steps, in full");
- it plays `$18`, or `$19` at full power (`$82:BFF0`).

Kirby's roll pose is chosen there too ([animation.md](animation.md) "Kirby's poses in play").

### The shot panel

The panel's objects are the shot thread's spawns: `$10` the panel, `$12` the "1", `$18` the meter. Their pictures and offsets come from the game's OAM (`tools/export_web_ui.py`; the Panel sprites row of [web-demo.md](web-demo.md) "Measured with the stepper (not in the older docs)"). The timings below are on the stepper's snapshots of web_ui. A snapshot shows the iteration before it (emulation.md), so a snapshot frame is a core frame + 1.

- **Opening**, from the aim's A (snapshot frames):
  - the "1" at + 46;
  - the panel at + 66, the gauge frame sliding in over 4 frames;
  - the selectors answer from + 70.

  On web_ui the curl came 26 frames after the A (2800 → 2826), so from the curl these are + 20, + 40 and + 44.
- **Closing**, from R, the core frame the meter latched (web_ui 3250; a stepper run with snapshots 3240-3281, 2026-11-14):
  - the gauge goes at R + 1: the meter reads 0, and gauge 0 is empty;
  - the face, the ruler, the marker and the tomatoes go at R + 22, the roll's first frame;
  - the "1" goes at R + 25.
- **The tomato about to be spent blinks** through the power stage, 8 frames off and 8 on, in phase with the curl: it is off in snapshots 3242-3249 and 3258-3265. When the blinking starts is not measured.
- **The OAM order**, front to back (snapshot f003180): the "1", the tomatoes, the gauge, the dot, the bar, the ruler, the gauge frame, the face.

## The roll

**The follow** (`$80:BA35`-`$80:BB8A`):
- The wanted lag is −24 x Kirby's motion. It is formed with ROL pairs; the integer word is clamped to `$70` (x) and `$60` (y), and the sign-magnitude result is negated.
- The lag eases toward it by (|e| >> 5) + 1 on both axes.
- The follow stops once `$D9D2` bit 0 is set.

The camera's formula is the Camera row of web-demo.md "Measured with the stepper (not in the older docs)".

**The fall.** The projection sets `$D9D2` bit 0 when z drops below 0 (`$81:A516`). On the first such frame `$81:A121` requests the fall's song: `$90` (song 18) at `$81:A175`, or `$8F` (17) in ball mode 10. The request blocks about 3 frames in the APU's port handshake `$80:B70A` ([audio.md](audio.md) "Which code plays what"); both fly traces skip from record 3252 to 3256. Then:
- the follow stops;
- `$6A88` counts 240 frames to the shot over, or fewer if z < −`$18_0000`;
- Kirby goes behind the course: `$82:F4FD` stores his OAM priority 1 once the handshake is over (web_fly 3256), and the shadow is already gone over the gap ([graphics.md](graphics.md) "Kirby behind the course").

**The roll's end waits for the HUD** (`$82:C172`). After the shot is over at O (`$D9BE`), the roll loop keeps running frames until `$68F4`, the HUD's tomato display, is clear. The display hides 89 iterations after the last tomato change (`$84:9990`). So the loop exits at E = max(O + 2, hidden + 1):
- web_flow: 3473 → 3475;
- web_tomatoes: 2529 → 2567, the HUD hidden at 2566.

**The shot's end, from E** (`$80:F37A`):
- **settled**: `$80:F39F` waits 30 frames. Then, with no tomato left, the game goes to "Out of tomatoes" below (`$80:F3AC`). Otherwise the turn top comes at E + 31 (web_flow 3506, web_tomatoes 2598).
- **lost** (`$80:F830`): GAME OVER if no life is left (`$80:F387`). Otherwise:

  | frame | what (web_fly) |
  |---|---|
  | E + 30 | the tomatoes go to 0, and the music stops with song `$7E` (`$80:F83B`, `$80:F845`; 3528) |
  | E + 33 | sound `$54` (3531) |
  | E + 79 | the ball is back at the shot's origin, with the block's airborne flag at 1 (3577) |

  From that reset X:

  | frame | what |
  |---|---|
  | X + 3 | the hole's song again (`$80:C967` from `$82:B0E8`; 3580) |
  | X + 61 | a life and sound `$0B` (`$80:F8D0`; 3638) |
  | X + 71 on | the refill `$80:F8DA`: 8 x (+1, then 10 frames), 3648-3718 |
  | X + 334 | the next set-up (3911) |

  The retake reloads the shot's own elevation, because `$80:F3A6` is skipped. In 1P the fall queues no tomato −1: `$82:C085` does so only when `$17FF` is set ([tiles.md](tiles.md) "Hazards").
- **holed** (`$80:F48C`): the hole-out, below.

## Tomatoes, lives and strokes

**The tomato queue** (`$83:ABC5` −1, `$83:ABAD` +1, the ring `$68FA`):
- The HUD thread (`$84:98EC` → `$83:ABDD`) takes one entry when it is idle, counts 20 frames and applies it. So a push lands 20 iterations later: the launch's push at 2982 lands at 3002, a take's at 3067 at 3087 (web_flow).
- It takes the next entry **in the tick that applies the one before** (`$84:9955`: the timer back to 20, state 1). Queued changes therefore land 20 iterations apart: web_haz98's roll −1 at 2474 and the bumper's at 2494.
- `$83:ABEC` stores a +1 only while the result stays under 5, with sound `$52`. A −1 floors at 0, with sound `$10`. The refill and the hole-out's bonus call it directly, unqueued.
- The cup's reveal holds the thread for 5 frames: a take at 3245 lands at 3270, not 3265.

**Lives** (`$D7F4`):
- a new game has 2 spare lives (`$80:C058`);
- −1 plays sound `$0B` (`$80:F876`, `$80:F8D0`);
- +1 is stored below 100 (`$80:F62D`).

At most 4 tomatoes.

**Running out of tomatoes does not end the hole** (`$82:E1EE`, then `$80:F85C`). It is measured on web_tomatoes from O, the end of `$80:F39F`'s wait (3606, where `$82:E20A` requests sound 0):

| frame | what |
|---|---|
| O + 15 | pose 3, song `$8F` (17), object `$BE`: Kirby falls asleep (3621) |
| O + 212 | object `$BE` is done (`$D798`); the hole's song again (`$80:C967` from `$82:E25B`; 3818). With no life left: GAME OVER (`$80:F3B5`) |
| O + 282 | a life, sound `$0B` (`$80:F876`; 3888) |
| O + 312 | object `$40`, sound `$77` (3918) |
| O + 348 on | the refill, 8 x (+1, 10 frames) (3954 …) |
| O + 449 | the turn top: the set-up on the same hole, the ball where it lies (4055) |

**GAME OVER** comes on either path when no life is left. CONTINUE gives 2 lives and starts the course again (`$80:F486`, `$80:C0C5`).

**Strokes** (`$D82A`): 1 at the hole's start (`$80:C1DC`), + 1 at each set-up, capped at 99. The card holds `$D82A` − 1. A hole in one is `$D82A` = 2 at the hole-out, and gives a life.

## The hole-out

The sink's end sets the shot over (physics.md "Enemies and the cup"), so the roll loop ends through `$82:C172` as above, and the main flow takes the holed path `$80:F48C`. From the next frame, `$83:C8A0` pans the camera toward the cup's projection (`$ECBB`, `$ECBD` + `$12`; the reveal wrote it) until it arrives. The card is written on that frame, C (`$83:D4F6`; web_hole 3911-3921). `$80:F60C` calls `$83:D2AB`, which tests `$D82A` for a hole in one.

From C, the same offsets hold on web_hole and on c1n (C = 3150 there):

| from C | ordinary | hole in one (c1n) |
|---|---|---|
| + 31 | song 25 (`$97`, `$83:D2B6`) | song 0 (`$7E`), then the night palette |
| + 58 | | song 26 (`$98`, `$83:D2DD`) |
| + 94 | the bonus tomato (`$80:F69E`) | at + 445 instead (unconfirmed) |
| + 147 | song 24 (`$96`, the star warp, `$83:C748`) | at + 498 |
| + 386 | | the 1UP (`$80:F62D`, sound `$2D`; unconfirmed) |
| + 410 | the blank before the RESULT card | at + 760 |

The hole-in-one frames come from c1n's recording only; the 1UP's and the bonus's are the least certain.

The star warp's rise moves the world camera (web_hole 4196-4260). That is the cutscene's camera track, recorded with the intro and the hole-out in web-demo.md "The intro and the hole-out (measured with the stepper)".
