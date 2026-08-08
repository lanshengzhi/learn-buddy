/**
 * TTS exception — the error vocabulary shared by backend and frontend
 * (ported from dasan's TtsException hierarchy; the backend returns these
 * codes as JSON). ViewModels map codes to learner-facing strings via
 * ttsErrorToMessage.
 */

export const TTS_ERROR_CODES = Object.freeze({
  EMPTY_TEXT: 'empty_text',
  TEXT_TOO_LONG: 'text_too_long',
  INVALID_VOICE: 'invalid_voice',
  INVALID_RATE: 'invalid_rate',
  UPSTREAM_UNAVAILABLE: 'upstream_unavailable',
  UPSTREAM_TIMEOUT: 'upstream_timeout',
  NETWORK_FAILURE: 'network_failure',
  UNKNOWN: 'unknown',
});

/** Wording carried over verbatim from the Android app (ReaderViewModel.mapTtsError). */
const ERROR_MESSAGES = {
  [TTS_ERROR_CODES.EMPTY_TEXT]: 'Selected sentence is empty.',
  [TTS_ERROR_CODES.TEXT_TOO_LONG]: 'Sentence is too long.',
  [TTS_ERROR_CODES.INVALID_VOICE]: 'Voice is not available.',
  [TTS_ERROR_CODES.INVALID_RATE]: 'Playback rate is invalid.',
  [TTS_ERROR_CODES.NETWORK_FAILURE]: 'Check your connection.',
  [TTS_ERROR_CODES.UPSTREAM_UNAVAILABLE]: 'Service is temporarily unavailable. Try again later.',
  [TTS_ERROR_CODES.UPSTREAM_TIMEOUT]: 'Service is temporarily unavailable. Try again later.',
  [TTS_ERROR_CODES.UNKNOWN]: 'Something went wrong. Please try again.',
};

/**
 * Maps a backend error code to the learner-facing string.
 * @param {string} code — one of TTS_ERROR_CODES
 * @returns {string}
 */
export function ttsErrorToMessage(code) {
  return ERROR_MESSAGES[code] ?? ERROR_MESSAGES[TTS_ERROR_CODES.UNKNOWN];
}
