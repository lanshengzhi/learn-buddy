import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShellController, Layer } from '../web/js/core/shell-controller.js';

const recorder = () => {
  const events = [];
  return { events, onEvent: (e) => events.push(e) };
};

test('shell starts on the Read face, nav expanded, no layers', () => {
  const shell = new ShellController();
  assert.equal(shell.state.activeFace, 'read');
  assert.equal(shell.state.navCollapsed, false);
  assert.deepEqual(shell.state.openLayers, []);
});

test('wide mode: toggleNav collapses and expands the nav (no layer)', () => {
  const { events, onEvent } = recorder();
  const shell = new ShellController({ narrow: false, onEvent });
  shell.toggleNav();
  assert.equal(shell.state.navCollapsed, true);
  shell.toggleNav();
  assert.equal(shell.state.navCollapsed, false);
  assert.deepEqual(shell.state.openLayers, []);
  assert.deepEqual(events.map((e) => e.type), ['nav-toggled', 'nav-toggled']);
});

test('narrow mode: toggleNav opens and closes the drawer layer', () => {
  const shell = new ShellController({ narrow: true });
  shell.toggleNav();
  assert.deepEqual(shell.state.openLayers, [Layer.Drawer]);
  shell.toggleNav();
  assert.deepEqual(shell.state.openLayers, []);
});

test('back() closes layers in spec §4.2 priority, not opening order', () => {
  const shell = new ShellController({ narrow: true });
  for (const layer of [Layer.Drawer, Layer.Toolbar, Layer.Identity, Layer.WordCard]) {
    shell.open(layer);
  }
  const closed = [];
  let layer;
  while ((layer = shell.back()) !== null) closed.push(layer);
  assert.deepEqual(closed, [Layer.WordCard, Layer.Identity, Layer.Toolbar, Layer.Drawer]);
  assert.deepEqual(shell.state.openLayers, []);
});

test('back() with nothing open returns null and emits nothing', () => {
  const { events, onEvent } = recorder();
  const shell = new ShellController({ onEvent });
  assert.equal(shell.back(), null);
  assert.deepEqual(events, []);
});

test('opening an already-open layer is a no-op', () => {
  const { events, onEvent } = recorder();
  const shell = new ShellController({ narrow: true, onEvent });
  shell.open(Layer.WordCard);
  shell.open(Layer.WordCard);
  assert.deepEqual(shell.state.openLayers, [Layer.WordCard]);
  assert.deepEqual(events.map((e) => e.type), ['layer-opened']);
});

test('viewport transitions reset the layer stack', () => {
  const { events, onEvent } = recorder();
  const shell = new ShellController({ narrow: true, onEvent });
  shell.open(Layer.Drawer);
  shell.open(Layer.WordCard);
  shell.setNarrow(false);
  assert.equal(shell.state.narrow, false);
  assert.deepEqual(shell.state.openLayers, []);
  assert.ok(events.some((e) => e.type === 'layers-reset'));
});

test('setNarrow with an unchanged value emits nothing', () => {
  const { events, onEvent } = recorder();
  const shell = new ShellController({ narrow: false, onEvent });
  shell.setNarrow(false);
  assert.deepEqual(events, []);
});

test('Read, Chat and Learn face switching emits state changes only', () => {
  const { events, onEvent } = recorder();
  const shell = new ShellController({ onEvent });
  shell.setFace('chat');
  shell.setFace('learn');
  shell.setFace('read');
  assert.deepEqual(events, [
    { type: 'face-changed', face: 'chat' },
    { type: 'face-changed', face: 'learn' },
    { type: 'face-changed', face: 'read' },
  ]);
  assert.equal(shell.state.activeFace, 'read');
});

test('setFace to the current face is a no-op (no event, no state churn)', () => {
  const { events, onEvent } = recorder();
  const shell = new ShellController({ onEvent });
  shell.setFace('read');
  assert.equal(shell.state.activeFace, 'read');
  assert.deepEqual(events, []);
});

test('setFace emits face-changed for the A layout’s primary nav', () => {
  const { events, onEvent } = recorder();
  const shell = new ShellController({ onEvent });
  shell.setFace('chat');
  assert.deepEqual(events, [{ type: 'face-changed', face: 'chat' }]);
});
