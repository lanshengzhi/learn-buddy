import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeFollowAction } from '../web/js/core/visual-follow.js';

// A 600px-tall list viewport; its bottom edge is the playback bar's top edge.
const vp = { top: 100, bottom: 700 };

test('visual follow: a fully visible card stays still', () => {
  assert.equal(computeFollowAction(vp, { top: 200, bottom: 300 }), 'stay');
  // Card filling the viewport exactly.
  assert.equal(computeFollowAction(vp, { top: 100, bottom: 700 }), 'stay');
});

test('visual follow: exact equality boundaries are fully visible', () => {
  // Bottom edge exactly at the viewport bottom (== the playback bar top):
  // the card is NOT covered, so it stays.
  assert.equal(computeFollowAction(vp, { top: 200, bottom: 700 }), 'stay');
  // Top edge exactly at the viewport top.
  assert.equal(computeFollowAction(vp, { top: 100, bottom: 400 }), 'stay');
});

test('visual follow: a card below the viewport page-turns to the top (smooth)', () => {
  assert.equal(computeFollowAction(vp, { top: 800, bottom: 900 }), 'scroll-top-smooth');
  // Just barely peeking below the bottom edge.
  assert.equal(computeFollowAction(vp, { top: 650, bottom: 710 }), 'scroll-top-smooth');
});

test('visual follow: a card above the viewport jumps to the top (instant)', () => {
  assert.equal(computeFollowAction(vp, { top: 50, bottom: 150 }), 'jump-top-instant');
  assert.equal(computeFollowAction(vp, { top: 0, bottom: 90 }), 'jump-top-instant');
});

test('visual follow: a sentence taller than the viewport settles top-anchored', () => {
  // 1100px card vs a 600px viewport: never fully visible. Once its top is at
  // the viewport top it counts as settled — no re-scroll on state changes.
  assert.equal(computeFollowAction(vp, { top: 100, bottom: 1200 }), 'stay');
  // Subpixel rounding after the scroll lands is still settled.
  assert.equal(computeFollowAction(vp, { top: 99.7, bottom: 1199.7 }), 'stay');
  // Below the viewport → page-turn so its top reaches the viewport top.
  assert.equal(computeFollowAction(vp, { top: 800, bottom: 1900 }), 'scroll-top-smooth');
  // Above the viewport (e.g. loop wrap onto a tall first sentence) → jump.
  assert.equal(computeFollowAction(vp, { top: 0, bottom: 1100 }), 'jump-top-instant');
});

test('visual follow: a card exactly as tall as the viewport', () => {
  // Fits exactly when aligned with the viewport top.
  assert.equal(computeFollowAction(vp, { top: 100, bottom: 700 }), 'stay');
  // Peeking below → page-turn.
  assert.equal(computeFollowAction(vp, { top: 150, bottom: 750 }), 'scroll-top-smooth');
  // Peeking above → jump.
  assert.equal(computeFollowAction(vp, { top: 50, bottom: 650 }), 'jump-top-instant');
});
