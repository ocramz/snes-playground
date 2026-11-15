/** Native SNES resolution; the canvas is zoomed to fit (main.ts). */
export const GAME_W = 256;
export const GAME_H = 224;

/**
 * The game's frame rate: NTSC SNES, 60.0988 Hz (docs/web-demo.md "Frame
 * rate"). The host runs fixed core frames at this rate and renders at the
 * display's, without interpolation.
 */
export const FRAME_HZ = 60.0988;
export const FRAME_MS = 1000 / FRAME_HZ;
/** At most this many core frames per host frame; the rest of a long stall is dropped. */
export const MAX_FRAMES_PER_HOST = 4;
