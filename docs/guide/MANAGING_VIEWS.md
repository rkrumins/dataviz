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

> 💡 **Edits are deliberate.** Panning, zooming, and exploring a View never change
> it. Only an explicit *save* updates the stored snapshot — so you can investigate
> freely inside a shared View without disturbing it.

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

> 💡 **Principle of least access:** share as narrowly as the need requires. It's
> easy to widen later and awkward to claw back.

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
| View opens empty | Wrong workspace active, or its data source changed — check the workspace switcher |
| Can't edit a View | You have *viewer* access only — ask the owner for an *editor* grant |

More in [Troubleshooting](/guide/troubleshooting).

---

## Where to next

- Shape what nodes *mean* across all Views → [The Semantic Layer](/guide/semantic-layer)
- Understand roles, groups, and grants → [Users & Access](/guide/users-access)
- Team conventions → [Ways of Working](/guide/ways-of-working)
