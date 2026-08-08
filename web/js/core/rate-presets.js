/**
 * Rate preset — one of the six learner-selectable speech rates on the
 * Reader's Rate control. Ported from dasan's RatePreset (kotlin enum):
 * each preset maps linearly to an SSML rate string; 2× sits at the upstream
 * +100% ceiling. Presets are synthesized server-side, so selecting one
 * re-fetches audio at that rate.
 */

export const RATE_PRESETS = [
  { name: 'Half', label: '0.5×', ssmlRate: '-50%' },
  { name: 'ThreeQuarters', label: '0.75×', ssmlRate: '-25%' },
  { name: 'Normal', label: '1×', ssmlRate: '+0%' },
  { name: 'OneAndQuarter', label: '1.25×', ssmlRate: '+25%' },
  { name: 'OneAndHalf', label: '1.5×', ssmlRate: '+50%' },
  { name: 'Double', label: '2×', ssmlRate: '+100%' },
];

export const DEFAULT_RATE_PRESET = RATE_PRESETS[2]; // Normal (1×)

export function ratePresetByName(name) {
  return RATE_PRESETS.find((p) => p.name === name) ?? DEFAULT_RATE_PRESET;
}

/**
 * SSML rate validation mirroring EdgeTtsProtocol.validateRate:
 * `^[+-]\d+%$` within [-90%, +100%]. The six presets are all within bounds.
 * @param {string} rate
 * @returns {boolean}
 */
export function isValidSsmlRate(rate) {
  if (!/^[+-]\d+%$/.test(rate)) return false;
  const numeric = parseInt(rate.slice(0, -1), 10);
  return numeric >= -90 && numeric <= 100;
}
