/**
 * Paste screen — text field, Paste from clipboard, Read, and the History
 * list with per-entry deletion. Mirrors dasan's PasteScreen/PasteViewModel.
 */

import { historyRepository, registerServiceWorker } from './bootstrap.js';
import { ttsErrorToMessage, TTS_ERROR_CODES } from './core/errors.js';

const textInput = document.getElementById('text-input');
const pasteButton = document.getElementById('paste-button');
const readButton = document.getElementById('read-button');
const pasteError = document.getElementById('paste-error');
const historyList = document.getElementById('history-list');
const historyEmpty = document.getElementById('history-empty');

function showError(message) {
  pasteError.textContent = message;
  pasteError.hidden = false;
}

function clearError() {
  pasteError.hidden = true;
}

textInput.addEventListener('input', () => {
  clearError();
  readButton.disabled = textInput.value.trim() === '';
});

pasteButton.addEventListener('click', async () => {
  try {
    if (!navigator.clipboard?.readText) {
      showError('Clipboard access is not available — paste manually instead.');
      textInput.focus();
      return;
    }
    const text = await navigator.clipboard.readText();
    if (!text || text.trim() === '') {
      showError('Clipboard has no text to paste');
      return;
    }
    textInput.value = text;
    readButton.disabled = false;
    clearError();
  } catch {
    showError('Could not read the clipboard — paste manually instead.');
    textInput.focus();
  }
});

readButton.addEventListener('click', () => {
  const text = textInput.value.trim();
  if (text === '') {
    showError('Please paste some text first.');
    return;
  }
  clearError();
  // Persist the pending passage across the navigation; History dedupe and
  // trimming happen here so the Reader can resolve its entry id.
  void (async () => {
    await historyRepository.add(text);
    sessionStorage.setItem('learnbuddy-pending-text', text);
    sessionStorage.setItem('learnbuddy-pending-selected', '-1');
    location.href = '/reader.html';
  })();
});

async function renderHistory() {
  const entries = await historyRepository.getRecent();
  historyEmpty.hidden = entries.length > 0;
  historyList.replaceChildren();
  for (const entry of entries) {
    const li = document.createElement('li');

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'history-entry';
    open.textContent = entry.text;
    open.addEventListener('click', () => {
      sessionStorage.setItem('learnbuddy-pending-text', entry.text);
      sessionStorage.setItem('learnbuddy-pending-selected', String(entry.lastSelectedIndex ?? -1));
      location.href = '/reader.html';
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'delete-entry';
    remove.textContent = '✕';
    remove.setAttribute('aria-label', 'Delete history entry');
    remove.addEventListener('click', async () => {
      // Delete clears the entry and purges audio no other entry references
      // (the ownership hook runs inside the repository).
      await historyRepository.deleteEntry(entry.id);
      await renderHistory();
    });

    li.append(open, remove);
    historyList.append(li);
  }
}

renderHistory();
registerServiceWorker();
