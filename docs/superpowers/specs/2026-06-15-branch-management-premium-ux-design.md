# Branch Management — Premium, business-friendly UX redesign

**Date:** 2026-06-15
**Status:** Approved (Approach A)
**Scope:** Core branch controls + a new Branch Manager overview. Presentational/UX only —
no backend, API, or URL-contract changes.

## Goal

Make all branch-management UI premium and legible to a **non-technical persona**. Replace
git jargon with plain business language, elevate the visual quality, and add a dedicated
Branch Manager for overseeing every draft.

## Decisions (from the user)

1. **Language:** plain-language relabel (not "keep terms + tooltips").
2. **Scope:** core controls **+** a new branches overview panel.
3. **Structure:** keep the quick-switch dropdown **and** add a dedicated Branch Manager.
4. **Approach A:** centralized vocabulary + polished switcher + Branch Manager drawer +
   consistent relabeling of lifecycle actions. (Not a route-based page; not a mega-dropdown.)

## Vocabulary — single source of truth (`branchVocab.ts`)

Presentational only. `?branch=` URL param, API field names, and DB stay unchanged.

| Concept (code)        | User-facing            |
|-----------------------|------------------------|
| main                  | **Published**          |
| draft / branch        | **Draft**              |
| commit / checkpoint   | **Save point**         |
| staged / uncommitted  | **Unsaved changes**    |
| merge / publish       | **Publish**            |
| pull latest / rebase  | **Get latest updates** |
| behind main           | **Updates available**  |
| abandon               | **Archive**            |
| merge request         | **Review request**     |

Status semantics (color): emerald = up to date, amber = updates available,
indigo/violet = publish action, rose = destructive (archive).

## Components

1. **`branchVocab.ts`** — exported label constants + small helpers (status label/tone for a
   draft given `baseCommitSeq` vs `mainHead`). One place to change wording.

2. **`BranchSwitcher` (elevate in place)** — button shows "Published" or the draft name.
   Dropdown: a "Published" row, a "Your drafts" group (status pill, owner, last-edited),
   quick actions, footer **+ New draft** and **Manage all drafts →** (opens Branch Manager).

3. **`BranchManager` (new slide-over drawer)** — opened from the switcher. Search + sort,
   one card per draft (name, description, status pill, owner avatar, last activity), and
   per-draft actions: Open · Get latest · Publish · Settings · Archive. Premium
   empty/loading/error states. Reuses `usePullLatestDraft`, `usePublishBranch`,
   `useAbandonDraft`, `useUpdateBranch`, `useOpenDraft`, `useBranches`.

4. **Lifecycle relabels** — `CommitDialog`, `PullLatestButton`, `PullBeforeMergeBanner`,
   `BranchSettingsModal` copy aligned to the vocabulary. Mechanisms unchanged.

5. **Premium visual system** — owner avatar (initials chip), relative timestamps (`timeAgo`),
   consistent status pills, framer-motion on the drawer/rows, polished empty/skeleton states.

## Out of scope

Changes hub, commit history, conflict resolver, diff views remain structurally untouched
(only shared wording aligned so nothing contradicts). No routing changes. No backend changes.

## Verification

- `tsc --noEmit` stays at the 81-error baseline (0 new).
- Existing versioning tests stay green; add tests for `branchVocab` status helper and the
  Branch Manager list (render + archive-confirm).
- Manual: switch branches, open Branch Manager, rename/archive/get-latest/publish a draft.
