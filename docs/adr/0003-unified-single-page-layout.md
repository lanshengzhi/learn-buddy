# Unified single-page layout: reading on top, editor at the bottom, at every width

> **Partially superseded for the family hub** (map #23, issue #38) — the "no breakpoint" claim holds for the reader's single-page layout it was written about, but **not for the shell map #23 adds**: a left rail and a right-side AI panel cannot share a phone screen. Issue #38 settles **one breakpoint at ~900px** — three columns above it; a drawer plus full-screen overlays below. The reader layout itself is unchanged, and the four decisions below still govern it.

ADR 0002 introduced a ≥1024px breakpoint: desktop got the single page (reading on top, collapsible editor at the bottom) while mobile kept the two-screen flow as two in-page views (Paste view ⇄ Reader view). Real-device acceptance exposed the cost: narrowing a desktop browser mid-session silently swapped the page into the two-view flow, hiding the reading area behind a view switch — and two interaction models meant two things to learn.

This ADR removes the breakpoint: the single-page layout is the one layout at every width and on every device.

## Decisions

- **No breakpoint, no view switching.** The `(min-width: 1024px)` breakpoint, the Paste view ⇄ Reader view switch, the 阅读 → button, and the header back button are gone. Resizing the window changes nothing.
- **Collapsible editor everywhere.** The editor rests as a bottom band — two lines with a mouse, one line on touch devices (textarea + 历史 button, no status line). It expands to the lower half of the screen when opened: empty text at start-up, or the 历史 button.
- **Touch takeover on focus.** On `(pointer: coarse)` devices, focusing the textarea takes over the full space above the virtual keyboard: the reading area slides out of view (~250ms) and returns when the editor collapses. With a mouse, focusing still expands to the lower half with the reading area visible — there is no keyboard to accommodate.
- **Collapse affordances.** 更新, blur (touch), Escape (keyboard), a visible 收起 button at the right end of the editor tab bar, or tapping a sentence card all collapse the editor. Tapping a control inside the editor while the takeover is active (更新, tabs, 收起, paste) keeps the takeover until that control's own handler acts.

## Considered Options

- **Width-based takeover (<1024px)** — rejected: reintroduces the breakpoint as a behavioral switch, and a narrowed desktop browser without a keyboard would take over pointlessly. Pointer-based matches the actual constraint (a virtual keyboard).
- **Keyboard-open detection via `visualViewport`** — rejected: more JS and flaky on Android Chrome; `pointer: coarse` is deterministic and zero-JS.
- **Fixed split (editor always open)** — rejected: the reading surface is the primary surface; a permanently half-height editor wastes it on small screens.

## Consequences

- The two-view vocabulary (Paste view / Reader view) is gone from the glossary; the layout terms are **Single-page layout**, **Editor**, **Reading area**.
- Opening a History entry loads the text and collapses the editor; there is no view to navigate to.
- `browser-smoke.mjs` rewritten: the mobile section now runs under touch emulation (`pointer: coarse`) and exercises the takeover, the one-line collapsed band, and the no-breakpoint guarantee when narrowing the window.
- The editor's 历史 button moved into the collapsed band; the collapsed status line (sentence summary) shows only with a mouse.
