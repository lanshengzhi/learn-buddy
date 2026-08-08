# Web desktop layout: single page with reading-on-top and a collapsible editor

LearnBuddy initially ported dasan's Android two-screen navigation verbatim — Paste screen and Reader screen as separate pages with a sessionStorage handoff — but desktop browsers are the primary usage, and learners kept needing to modify or append text and re-paste, which the two-page hop made painful. A three-variant UI prototype (side-by-side split, overlay drawer, in-page view switch) settled the design: **one page** (`index.html`; `reader.html` redirects), **reading area on top, editor at the bottom** — the editor collapses to two lines, expands to the lower half of the screen on focus, and collapses again on 更新. Mobile keeps the Android two-screen flow as two in-page views (Paste view ⇄ Reader view) behind a ≥1024px breakpoint; the sessionStorage handoff is gone. Web UI copy defaults to Chinese (the Android app stays English). History favorites (star) are exempt from the 50-entry trimming bound; non-favorites stay capped at 50.

## Considered Options

- **Left-right master-detail split** — rejected: two narrow columns compete on smaller laptops; the reading column was the real surface and got squeezed.
- **Overlay drawer** — rejected: hiding the editor made the modify-and-re-read loop one step longer.
- **In-page view switch** — rejected for desktop: editing and reading alternate instead of coexisting; fine as the mobile fallback.

## Consequences

- The Service Worker shell list changes (`/reader.html`, `/js/reader.js` removed; shell cache bumped to v2); old installed shells fall back to the redirect stub.
- Audio ownership for offline replay now keys to the History entry created on 更新/阅读; auto re-segment alone does not commit, and the first playback of an uncommitted text ensures its entry exists.
- Re-segmentation preserves the selected sentence by exact content match when it still exists, else falls back to the first sentence.
- History favorites survive trimming; deletion and audio purging still apply to them.
