# Workspace Admin

```tour-workspaces
```

*For Administrators.* [Admin Setup](/guide/admin-setup) gets your *first*
workspace running. This page covers what you'll actually do most days after
that: creating new workspaces, managing their data sources, moving things
around as teams change, and keeping an eye on your Views collection and
ontology health.

---

## Creating a workspace

From **Workspaces**, start the wizard:

1. **Basics** — give it a clear name ({brand} checks for duplicates as you
   type and suggests an alternative if it's taken) and an optional
   description.
2. **Data** — optionally connect a catalog item now, or skip and add one
   later.
3. **Review** — confirm and create.

You can jump straight into the new workspace when it's done.

---

## Adding a data source

A workspace isn't usable until it has at least one **data source** — a
catalog item (the graph) bound to an ontology (its meaning). The wizard:

1. **Source** — pick which catalog item to attach.
2. **Semantics** — choose the ontology. {brand} ranks the available options by
   how much of the graph's actual types they cover, and marks the best match
   for you — so you're not guessing which semantic layer fits.
3. **Review** — confirm and attach.

---

## Moving a data source between workspaces

Teams reorganize, and data sources sometimes need to move with them. The same
Add Data Source wizard handles this: pick a source that already belongs to
another workspace, and the wizard switches into **move mode**.

> **Warning:** A data source can only move if nothing is built on it. If any
> Views exist against it in its current workspace, it isn't offered as movable —
> you'll see it listed but disabled, with a note showing how many Views
> depend on it. This protects those Views from breaking out from under
> their owners.

Sources that *are* eligible show a clear **Move** option, along with which
workspace currently holds them. Moving one takes its aggregation state and
stats with it — the members of its old workspace simply lose access, and the
new workspace gains a fully working data source, not a blank slate.

---

## Governing your Views (the Views tab)

Every workspace has a **Views** tab built for oversight, not just browsing:

- **At a glance**: total Views, how many you own, how many distinct owners
  there are, and when something last changed.
- **Filter by visibility** — Private, Workspace, or Enterprise — and jump
  straight to Views that **need attention**.
- **Search, filter by data source or owner, and sort**, in either a grid or a
  detailed list.
- **Bulk actions** — change the visibility of several Views at once, or
  delete a batch you've confirmed are safe to remove.

### Per-view activity history

Click into any View's **Activity** to see a full, day-by-day timeline of what
happened to it — created, edited, shared, its visibility changed, or its
underlying data updated — each entry naming who did it and, for edits, what
specifically changed. Filter by channel (Data / Settings / Sharing) or by
person when you need to answer "who changed this, and when."

---

## Checking ontology health

The **Health** tab (inside your Semantic Layer settings) answers a narrower
but important question: *does the data in your graph actually match what your
ontology declares?* Every type is classified as:

| Status | Meaning |
| --- | --- |
| **Exact** | The data matches your ontology's naming exactly. |
| **Case drift** | The data is there, but the capitalization doesn't match — so it's silently invisible to anything that depends on exact naming. |
| **Unmapped** | The data doesn't correspond to anything in your ontology at all. |

The tab leads with a plain verdict — *fully aligned*, or *needs attention*
with a count of what's drifted or unmapped — before you drill into any detail,
and it works from data collected periodically, not a live query, so it's fast
to check. Case drift is usually the easy win: {brand} can normalize it for
you rather than requiring a manual data fix.

---

## Where to next

- Approve people and manage their access → [Users & Access](/guide/users-access)
- Keep the platform healthy day to day → [Governance & Operations](/guide/governance-ops)
- Understand ontologies in depth → [The Semantic Layer](/guide/semantic-layer)
