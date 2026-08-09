import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HistoryRepository, MAX_ENTRIES } from '../web/js/core/history-repository.js';
import { InMemoryHistoryStore } from '../web/js/core/history-store.js';
import { record, forgetEntries, refsToObject, refsFromObject } from '../web/js/core/audio-ownership.js';

function makeRepo({ onEntriesRemoved } = {}) {
  const store = new InMemoryHistoryStore();
  const removed = [];
  const repo = new HistoryRepository(store, {
    onEntriesRemoved: async (ids) => {
      removed.push(...ids);
    },
  });
  return { repo, store, removed };
}
test('add stores trimmed text as the newest entry', async () => {
  const { repo } = makeRepo();
  await repo.add('  Hello world.  ');
  const recent = await repo.getRecent();
  assert.equal(recent.length, 1);
  assert.equal(recent[0].text, 'Hello world.');
});

test('add ignores blank text', async () => {
  const { repo } = makeRepo();
  const entry = await repo.add('   \n ');
  assert.equal(entry, null);
  assert.deepEqual(await repo.getRecent(), []);
});

test('duplicate texts collapse into one entry with the newest timestamp', async () => {
  let now = 1000;
  const { repo } = makeRepo();
  repo.now = () => now;
  await repo.add('Same text');
  const first = await repo.getRecent();
  now = 2000;
  await repo.add('Same text');
  const recent = await repo.getRecent();
  assert.equal(recent.length, 1);
  assert.equal(recent[0].id, first[0].id);
  assert.equal(recent[0].createdAt, 2000);
});

test('recent entries are ordered newest first', async () => {
  let now = 1000;
  const { repo } = makeRepo();
  repo.now = () => now;
  await repo.add('first');
  now = 2000;
  await repo.add('second');
  const recent = await repo.getRecent();
  assert.deepEqual(recent.map((e) => e.text), ['second', 'first']);
});

test('history is capped at MAX_ENTRIES and trims the oldest', async () => {
  let now = 1000;
  const { repo, removed } = makeRepo();
  repo.now = () => now++;
  for (let i = 0; i < MAX_ENTRIES + 5; i++) {
    await repo.add(`entry ${i}`);
  }
  const recent = await repo.getRecent();
  assert.equal(recent.length, MAX_ENTRIES);
  // The five oldest ('entry 0'..'entry 4') were trimmed away.
  assert.ok(!recent.some((e) => e.text === 'entry 0'));
  assert.deepEqual(removed.sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  assert.equal(recent[0].text, `entry ${MAX_ENTRIES + 4}`);
});

test('deleteEntry removes the entry and reports the id for audio cleanup', async () => {
  const { repo, removed } = makeRepo();
  await repo.add('doomed');
  const entry = (await repo.getRecent())[0];
  await repo.deleteEntry(entry.id);
  assert.deepEqual(await repo.getRecent(), []);
  assert.deepEqual(removed, [entry.id]);
});

test('updateLastSelectedIndex records progress on the matching entry only', async () => {
  const { repo } = makeRepo();
  await repo.add('passage');
  await repo.updateLastSelectedIndex('passage', 3);
  let entry = (await repo.getRecent())[0];
  assert.equal(entry.lastSelectedIndex, 3);
  await repo.updateLastSelectedIndex('   passage  ', 7);
  entry = (await repo.getRecent())[0];
  assert.equal(entry.lastSelectedIndex, 7);
  await repo.updateLastSelectedIndex('unknown text', 2);
  entry = (await repo.getRecent())[0];
  assert.equal(entry.lastSelectedIndex, 7);
});

test('setFavorite toggles the star flag on the matching entry', async () => {
  const { repo } = makeRepo();
  await repo.add('passage');
  const entry = (await repo.getRecent())[0];
  assert.equal(entry.favorite, false);
  await repo.setFavorite(entry.id, true);
  assert.equal((await repo.getRecent())[0].favorite, true);
  await repo.setFavorite(entry.id, false);
  assert.equal((await repo.getRecent())[0].favorite, false);
});

test('trimming skips favorited entries; non-favorites stay bounded', async () => {
  let now = 1000;
  const { repo, removed } = makeRepo();
  repo.now = () => now++;
  for (let i = 0; i < MAX_ENTRIES + 5; i++) {
    await repo.add(`entry ${i}`);
  }
  // Favorite the oldest survivor ('entry 5'), which the next add would trim.
  const target = (await repo.getRecent()).find((e) => e.text === 'entry 5');
  assert.ok(target, 'entry 5 exists before trimming');
  await repo.setFavorite(target.id, true);
  await repo.add('one more');
  const recent = await repo.getRecent();
  assert.ok(recent.some((e) => e.id === target.id), 'favorite survives trimming');
  const nonFavorites = recent.filter((e) => !e.favorite);
  assert.equal(nonFavorites.length, MAX_ENTRIES);
  assert.ok(!removed.includes(target.id), 'favorite id is not reported as removed');
});

test('getRecent returns favorites even beyond the bound', async () => {
  let now = 1000;
  const { repo } = makeRepo();
  repo.now = () => now++;
  for (let i = 0; i < MAX_ENTRIES + 10; i++) {
    await repo.add(`entry ${i}`);
  }
  // The oldest 10 were trimmed already; favorite a survivor, then push more.
  const survivor = (await repo.getRecent())[0];
  await repo.setFavorite(survivor.id, true);
  for (let i = 0; i < 5; i++) {
    await repo.add(`new ${i}`);
  }
  const recent = await repo.getRecent();
  assert.ok(recent.some((e) => e.id === survivor.id));
});

test('duplicate add keeps the favorite flag on the collapsed entry', async () => {
  let now = 1000;
  const { repo } = makeRepo();
  repo.now = () => now;
  await repo.add('Same text');
  const entry = (await repo.getRecent())[0];
  await repo.setFavorite(entry.id, true);
  now = 2000;
  await repo.add('Same text');
  const collapsed = (await repo.getRecent())[0];
  assert.equal(collapsed.id, entry.id);
  assert.equal(collapsed.favorite, true);
  assert.equal(collapsed.createdAt, 2000);
});

test('deleteEntry removes a favorite like any other entry', async () => {
  const { repo, removed } = makeRepo();
  await repo.add('doomed');
  const entry = (await repo.getRecent())[0];
  await repo.setFavorite(entry.id, true);
  await repo.deleteEntry(entry.id);
  assert.deepEqual(await repo.getRecent(), []);
  assert.deepEqual(removed, [entry.id]);
});

test('audio ownership: references follow the ownership lifetime rule', () => {
  const refs = new Map();
  record(refs, '/tts?text=A&voice=v&rate=%2B0%25', 1);
  record(refs, '/tts?text=A&voice=v&rate=%2B0%25', 2); // shared by two entries
  record(refs, '/tts?text=B&voice=v&rate=%2B0%25', 1);

  // Removing entry 2 orphans nothing (A still referenced by 1).
  assert.deepEqual(forgetEntries(refs, [2]), []);
  // Removing entry 1 orphans both URLs.
  assert.deepEqual(forgetEntries(refs, [1]).sort(), [
    '/tts?text=A&voice=v&rate=%2B0%25',
    '/tts?text=B&voice=v&rate=%2B0%25',
  ]);
  assert.equal(refs.size, 0);
});

test('audio ownership survives serialization round-trip', () => {
  const refs = new Map();
  record(refs, 'url-1', 7);
  record(refs, 'url-1', 9);
  record(refs, 'url-2', 9);
  const restored = refsFromObject(refsToObject(refs));
  assert.deepEqual([...restored.get('url-1')], [7, 9]);
  assert.deepEqual([...restored.get('url-2')], [9]);
  // url-1 is still referenced by entry 9, so removing only 7 orphans nothing.
  assert.deepEqual(forgetEntries(restored, [7]), []);
  assert.deepEqual(forgetEntries(restored, [9]).sort(), ['url-1', 'url-2']);
});

test('history removal triggers ownership cleanup end-to-end', async () => {
  // Simulates the browser wiring: repository reports removed ids,
  // ownership drops them and yields orphaned urls.
  const { repo, store } = makeRepo();
  const refs = new Map();
  await repo.add('passage one');
  const e1 = (await repo.getRecent())[0];
  record(refs, '/tts?text=one', e1.id);
  await repo.deleteEntry(e1.id);
  const orphaned = forgetEntries(refs, [e1.id]);
  assert.deepEqual(orphaned, ['/tts?text=one']);
  assert.equal(refs.size, 0);
});
