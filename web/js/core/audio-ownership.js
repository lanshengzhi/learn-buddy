/**
 * AudioOwnership — the reference map between audio cache entries and History
 * entries (dasan ADR 0008 semantics, web edition).
 *
 * Audio lives exactly as long as at least one History entry references it.
 * The Reader records a reference (request URL of a played sentence, which is
 * the Service Worker audio-cache key) against the open passage's entry id;
 * when entries are deleted or trimmed, forgetEntries returns the URLs whose
 * reference count dropped to zero so the caller can purge them from the
 * Service Worker cache.
 *
 * The module is pure (plain objects + functions) so node tests can exercise
 * it; the browser adapter (audio-ownership-idb.js) persists the map in
 * IndexedDB and purges the Cache API.
 */

/**
 * Records that a history entry references an audio URL.
 * @param {Map<string, Set<number>>} refs — audio url -> entry ids
 * @param {string} url — the audio cache request URL
 * @param {number} entryId — the History entry id
 * @returns {Map<string, Set<number>>} the same refs map (mutated)
 */
export function record(refs, url, entryId) {
  let ids = refs.get(url);
  if (!ids) {
    ids = new Set();
    refs.set(url, ids);
  }
  ids.add(entryId);
  return refs;
}

/**
 * Drops removed entry ids from every reference. Returns the URLs that no
 * live entry references anymore — the caller should purge those from the
 * Service Worker audio cache. Mirrors "deleted except those still referenced
 * by other live entries".
 *
 * @param {Map<string, Set<number>>} refs
 * @param {number[]} removedEntryIds
 * @returns {string[]} orphaned audio URLs
 */
export function forgetEntries(refs, removedEntryIds) {
  const removed = new Set(removedEntryIds);
  const orphaned = [];
  for (const [url, ids] of refs) {
    for (const id of removed) ids.delete(id);
    if (ids.size === 0) {
      orphaned.push(url);
      refs.delete(url);
    }
  }
  return orphaned;
}

/** Serializes the refs map for persistence (IndexedDB / JSON). */
export function refsToObject(refs) {
  const out = {};
  for (const [url, ids] of refs) out[url] = [...ids];
  return out;
}

/** Rehydrates a refs map from refsToObject output. */
export function refsFromObject(obj = {}) {
  const refs = new Map();
  for (const [url, ids] of Object.entries(obj)) refs.set(url, new Set(ids));
  return refs;
}
