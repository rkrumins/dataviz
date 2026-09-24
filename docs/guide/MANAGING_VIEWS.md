# Managing Views

*For Builders.* Creating a View is the start; keeping your team's collection
useful is the ongoing job. This page covers editing, organising, sharing, and
the per-workspace tools for managing Views at scale.

---

## Editing a View

Open a View you own (or have edit access to) and you can:

- **Rename** it and update its **description** inline.
- **Adjust the picture** — re-trace, change filters or granularity, add or remove
  nodes — then **re-save** to update the snapshot.
- **Re-tag** to keep it discoverable as your conventions evolve.

> **Note:** Edits are deliberate. Panning, zooming, and exploring a View never
> change it. Only an explicit *save* updates the stored snapshot — so you can
> investigate freely inside a shared View without disturbing it.

---

## Versions of a View

Every View keeps a history of its **design** — its layers, placements, rules and
settings — as numbered versions: v1, v2, v3…

A version is kept whenever something meaningful happens: saving in the View
wizard, importing a file, restoring an earlier version, a draft's changes to the
View going live, or exporting unsaved changes. Changes you make on the canvas
between versions show as **unsaved changes since vN** until the next one.

Open **Versions** in the View's header (it shows the current version, with a dot
when there are unsaved changes) to:

- **Save version** — keep the design as it is now, with a note on what changed.
- **Compare** any two versions, or a version with the current design: which
  layers were added, removed or changed, and how many placements moved.
- **Restore** an earlier version. Your current design is saved as a version first,
  so nothing is lost, and sharing is left as it is.
- **Export** an earlier version to a file.

> **Note:** *Versions of a View are not the graph's version control.* They record
> the View's design only. Restoring one never changes the graph data, and graph
> drafts, commits and publishing work as before — see
> [Versioning & Change Control](/guide/versioning-change-control).

---

## Moving a View to another environment

Built a View in dev and need it in UAT or production? **Export** it to a file
(from the View's header, its menu in the Explorer, or several at once from the
Explorer's selection bar) and **Import view** in the other environment. The
import checks every entity the View places against the graph there and shows you
what matched before anything is saved. Importing again later updates the same
View as its next version. The whole journey is in
[Import & Export](/guide/import-export#moving-views-between-environments).

---

## Sharing and permissions

Two mechanisms control who can reach a View:

### 1. Visibility (the broad setting)
Set when you create the View, changeable later:

| Visibility | Who can open |
| --- | --- |
| **Personal** | Just you |
| **Team** | Everyone in the workspace |
| **Enterprise** | Everyone in the organisation |

### 2. Explicit shares (resource grants)
Beyond visibility, you can grant **specific people or groups** access to an
individual View, with a role:

| Grant | They can… |
| --- | --- |
| **Viewer** | Open and explore the View |
| **Editor** | Open, modify, and re-save the View |

Explicit shares are perfect for co-ownership ("let Dana edit this") or for
reaching someone outside the View's normal visibility. See the broader access
model in [Users & Access](/guide/users-access).

> **Tip:** *Principle of least access* — share as narrowly as the need requires.
> It's easy to widen later and awkward to claw back.

---

## Favourites and organisation

- **Favourite (★)** the Views you use most — they pin to your sidebar's quick
  access. Favourites are personal.
- Lean on **tags** and clear **names** so the gallery's search and filters do the
  organising for you. There are no folders; *good metadata is the filing system*.

---

## The per-workspace View Manager

Each workspace has a **Views Manager** for working with that workspace's
collection in one place. Use it to:

- see **all Views** in the workspace at a glance,
- **create** a new View,
- perform **bulk actions** (e.g. delete or adjust several at once),
- review ownership and visibility for tidy-ups.

This is where you do periodic **housekeeping** — retiring stale Views, fixing
inconsistent tags, and promoting the genuinely useful ones to Team or Enterprise
visibility.

---

## Lifecycle and good hygiene

Views accumulate. A little maintenance keeps the gallery trustworthy:

1. **Promote** Views that prove broadly useful (Personal → Team → Enterprise).
2. **Retire** Views that are stale or superseded — delete or clearly rename them
   (e.g. prefix with `[deprecated]`).
3. **Standardise** names and tags during housekeeping passes.
4. **Co-own** important Views via editor grants so they survive someone leaving.

See recommended cadence and conventions in [Ways of Working](/guide/ways-of-working).

---

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| A teammate can't find your View | Visibility too narrow, or wrong workspace — widen visibility or share explicitly |
| View opens empty | You're in the wrong workspace, or its data source changed — open **Workspaces** from the sidebar to confirm you're in the right one |
| Can't edit a View | You have *viewer* access only — ask the owner for an *editor* grant |
| No **Versions**, **Export** or **Import view** | They are a preview, off until your administrator turns it on (Admin → Features → View versions, import and export). Export and Import each have their own switch too (Export views / Import views) |

More in [Troubleshooting](/guide/troubleshooting).

---

## Where to next

- Shape what nodes *mean* across all Views → [The Semantic Layer](/guide/semantic-layer)
- Understand roles, groups, and grants → [Users & Access](/guide/users-access)
- Move Views between environments → [Import & Export](/guide/import-export#moving-views-between-environments)
- Team conventions → [Ways of Working](/guide/ways-of-working)
