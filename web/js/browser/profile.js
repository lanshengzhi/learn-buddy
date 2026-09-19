/**
 * Profile selection — `lb.profile` is the only browser-side learner key
 * (ADR 0007): the device remembers who last used it. Everything else
 * (positions, history, words, preferences) lives on the server keyed by the
 * active Profile.
 */

const KEY = 'lb.profile';

export function storedProfile() {
  try {
    return localStorage.getItem(KEY) || null;
  } catch {
    return null;
  }
}

export function storeProfile(profileId) {
  localStorage.setItem(KEY, profileId);
}

/** Switches Profiles: the caller reloads so every context is rebuilt cleanly. */
export function switchProfile(profileId) {
  storeProfile(profileId);
  location.reload();
}
