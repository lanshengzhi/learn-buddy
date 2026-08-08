/**
 * Playback preferences — the Reader's global playback preferences (active
 * Rate preset and Loop mode), persisted across sessions (dasan ADR 0009).
 * Restore is mode-only: the Reader never auto-resumes playback from a
 * restored mode. Browser storage is localStorage; tests inject a fake.
 */

import { DEFAULT_RATE_PRESET, ratePresetByName } from './rate-presets.js';
import { LoopMode, loopModeByName } from './loop-mode.js';

const KEY_RATE_PRESET = 'rate_preset';
const KEY_LOOP_MODE = 'loop_mode';

export class PlaybackPreferences {
  /**
   * @param {object} storage — {getItem, setItem} (localStorage in browser)
   */
  constructor(storage) {
    this.storage = storage;
  }

  ratePreset() {
    return ratePresetByName(this.storage.getItem(KEY_RATE_PRESET));
  }

  loopMode() {
    const name = this.storage.getItem(KEY_LOOP_MODE);
    const mode = loopModeByName(name);
    return mode === null ? LoopMode.Off : mode;
  }

  saveRatePreset(preset) {
    this.storage.setItem(KEY_RATE_PRESET, preset.name);
  }

  saveLoopMode(mode) {
    this.storage.setItem(KEY_LOOP_MODE, mode);
  }
}

export function playbackPreferences(storage = localStorage) {
  return new PlaybackPreferences(storage);
}
