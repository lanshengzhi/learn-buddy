/**
 * Playback preferences backed by the server's /state endpoint (ADR 0007):
 * the Rate preset and Loop mode are Profile preferences, not device ones.
 * Restore is mode-only — playback never auto-resumes from a restored mode.
 * Reads come from a preloaded snapshot (the boot fetch); saves are
 * fire-and-forget PUTs. Server writes may fail silently when the LAN drops —
 * the app is an empty shell then anyway (ADR 0007).
 */

import { DEFAULT_RATE_PRESET, ratePresetByName } from '../core/rate-presets.js';
import { LoopMode, loopModeByName } from '../core/loop-mode.js';

const PRESET_NAMES = new Set(['Half', 'ThreeQuarter', 'Normal', 'OneAndQuarter', 'OneAndHalf', 'Double']);
const LOOP_NAMES = new Set(['Off', 'All', 'One']);

export class ServerPlaybackPreferences {
  /**
   * @param {import('../core/api.js').ServerApi} api
   * @param {object} [snapshot] — the /state payload fetched during boot
   */
  constructor(api, snapshot = {}) {
    this.api = api;
    this.ratePresetName = PRESET_NAMES.has(snapshot.rate_preset) ? snapshot.rate_preset : DEFAULT_RATE_PRESET.name;
    this.loopModeName = LOOP_NAMES.has(snapshot.loop_mode) ? snapshot.loop_mode : LoopMode.All;
  }

  ratePreset() {
    return ratePresetByName(this.ratePresetName);
  }

  loopMode() {
    const mode = loopModeByName(this.loopModeName);
    return mode === null ? LoopMode.All : mode;
  }

  saveRatePreset(preset) {
    this.ratePresetName = preset.name;
    this.api.putState({ rate_preset: preset.name }).catch(() => {});
  }

  saveLoopMode(mode) {
    this.loopModeName = mode;
    this.api.putState({ loop_mode: mode }).catch(() => {});
  }
}
