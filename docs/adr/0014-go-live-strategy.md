# ADR 0014: Go-live strategy — parallel `/next`, staged trial, rename on old-shell deletion

Date: 2026-09-23
Status: Accepted
Tickets: [#42](https://github.com/lanshengzhi/learn-buddy/issues/42) (this decision)

The new shell replaces an application that four people use daily. It goes live **in parallel at `/next`**, reaches the family in **stages**, rolls back on a short list of hard lines, and the `?profile=` → `?person=` rename lands **in the same commit that deletes the old shell** — with no alias period in between.

## Context

- `learnbuddy.service` on claw serves the current reader at `:80` to four people. The data plane (book library, reading positions, word state, History) must not break; the specification only **adds** `highlights.json` / `notes.json` (§6.2), which the old shell never reads.
- The new shell is a **rewrite** of the `web/` IA (spec §4), not a revision of it.
- Narrow-screen regressions are measured, not theoretical: the prototype (issue #41) produced two distinct reading-position-losing bugs (`1049 → 0 → 0`) and reproduced the iOS Safari virtual-keyboard failure mode (spec §4.2).
- The server dispatches by hand-written `ROUTE_TABLE` plus a static mount, so serving a second shell under a path prefix requires no change to any existing route.
- Spec §9.4 schedules the `?profile=` → `?person=` rename "together with the API rebuild" and keeps the old spelling in the implementation until then.

## Decisions

- **Replacement is parallel, not a flag, not a big bang.** The new shell lives in its own directory, served at `/next/` by the same service; the old shell at `/` stays untouched. Both shells share the data plane. Cutover is a default-route change; rollback is changing it back.
- **Trial proceeds in three stages.** Stage 1: the maintainer only, one wide-screen and one narrow-screen device — **iOS Safari is mandatory**, because the §4.2 virtual-keyboard failure mode reproduces only there. Stage 2: after the spec §11 checklist passes on real devices, the household's heaviest reader (mom) uses `/next` for a week — she is the most sensitive to reading-position and Highlight regressions. Stage 3: family cutover by flipping the default route.
- **The rollback line is short and hard.** Any one triggers immediate rollback: user data lost and not re-anchorable; a core reading-path regression (open book / TTS / lookup); the service fails to start. Usability complaints are soft lines: they become issues and are fixed forward, never a rollback — rollback under the parallel scheme costs one route change, so there is no reason to hesitate on hard lines or to spend it on soft ones.
- **The old shell is retained until two weeks after cutover with no rollback event**, then deleted.
- **The rename lands in the same commit as the old-shell deletion.** While the old shell lives, the API keeps the old spelling (spec §9.4) and the new shell speaks `Person` internally, spelling `?profile=` only at its HTTP boundary. When the old shell dies, the reason not to rename dies with it: one commit, no alias period, no compatibility surface.

## Considered Options

- **Feature flag, one codebase, two IAs** — rejected: the new shell is a rewrite, so a flag means maintaining two interleaved IAs through the whole build and then ripping the flag out. The most expensive of the three paths.
- **Big bang** — rejected: any narrow-screen regression (virtual keyboard, reading position) hits the whole family at once, and §4.2 shows those regressions are real. Rollback would itself be a service interruption.
- **Early rename with `?profile=`/`?person=` aliases** — rejected: an alias period is pure complexity — every endpoint gains a "which spelling" question — and it buys nothing, because the old shell's existence is the only reason the rename has to wait.

## Consequences

- **Highlight / Note records written during the trial are real data.** A rollback does not lose them (the files stay, per §6.2's never-silently-drop rule); the old shell simply does not render them. This asymmetry is accepted and worth stating to the family if a rollback ever happens.
- **The two-week retention clock starts at default-route cutover**, not at `/next` availability.
- **`/next` must be reachable without touching existing routes** — a new static mount, nothing else. The day the default route flips, `/` serves the new shell and the old one is still reachable at its own path until deletion.
- For issue #43's ordering: because the family sees nothing until cutover, "the first slice the family can use" no longer constrains sequencing — slices are dogfooded by the maintainer at `/next`, and ordering can optimize for risk burndown instead.
