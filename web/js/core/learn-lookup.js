/** Build the /next Learn lookup bridge onto BookView's existing word-card path. */
export function createLearnLookupBridge(bookView) {
  if (!bookView || typeof bookView.lookupText !== 'function') {
    throw new TypeError('BookView lookupText is required');
  }
  return ({ word, sentence, language }) => bookView.lookupText({ word, sentence, language });
}
