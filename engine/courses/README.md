# Test courses

Authored `*.course.json` holes in the engine's own format, played by the
test suite and the dev build alongside the shipped ROM holes.

The format lands with `src/core/course-data.ts` (implementation step 3) and
the holes themselves with the hole/course loop (implementation step 6) of
plans/port_v1_koota_phaser4.md: 8 small holes that together exercise every
terrain shape, steps, gaps, walls, outline walls, friction, boost, kickers,
hazards, pillars, enemies and the cup. A schema check runs in a test.
