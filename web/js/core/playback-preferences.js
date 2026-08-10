/**
 * Playback preferences — the Reading area's global playback preferences
 * (active Rate preset and Loop mode), persisted across sessions. Restore is
 * mode-only: playback never auto-resumes from a restored mode. Browser
 * storage is localStorage; tests inject a fake.
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
    return mode === null ? LoopMode.All : mode;
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
