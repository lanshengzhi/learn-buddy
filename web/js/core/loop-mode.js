/**
 * Loop mode — the Reading area's playback mode, switched by the Loop toggle
 * in the bottom bar. Each tap cycles Off → All → One → Off. The mode
 * persists across sessions and applies globally; restore is mode-only and
 * never auto-resumes playback. Loop playback (All) is the default for
 * fresh sessions.
 */

export const LoopMode = Object.freeze({
  Off: 'Off',
  All: 'All',
  One: 'One',
});

export const LOOP_CYCLE = [LoopMode.Off, LoopMode.All, LoopMode.One];

export function nextLoopMode(mode) {
  const index = LOOP_CYCLE.indexOf(mode);
  return LOOP_CYCLE[(index + 1) % LOOP_CYCLE.length];
}

export function loopModeByName(name) {
  return LOOP_CYCLE.includes(name) ? name : LoopMode.All;
}
