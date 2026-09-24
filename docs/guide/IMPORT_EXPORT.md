# Import & Export

*For Builders and Administrators.* Bring data in from a spreadsheet, or take a
full backup out — both go through the same **draft-and-review** safety net as
any other change, so a bad import can never silently corrupt your graph. Views
travel too: see [Moving views between environments](#moving-views-between-environments).

> **Note:** *The one-sentence model* — Import stages changes on a draft for you
> to review before anything publishes; Export gives you a complete,
> re-importable copy of the graph whenever you need one.

---

## Where to find it

Look for the **Import / Export** menu in the header, in either View or Edit
mode. **Export** always works, with or without version control. **Import** needs
an open draft — if you're not already in Edit mode, the menu tells you to start
one first. (If your data source doesn't have version control turned on, Import
won't appear at all — see [Versioning & Change Control](/guide/versioning-change-control).)

---

## Importing data

Import is built for bulk changes — onboarding a new system's worth of tables,
correcting a batch of metadata, or loading a one-off dataset — without hand-
editing dozens of nodes on the canvas.

1. **Download a starter template**, or use your own file. Excel, CSV, TSV,
   NDJSON, and JSON are all supported (older formats like `.xls` or Numbers
   files aren't — save as CSV first).
2. **Edit it** anywhere — a spreadsheet, a script, whatever's convenient.
3. **Upload it.** The import runs in the background, so you can keep working
   while it processes. One file can be up to 100 MB; split a larger one and
   import the parts one after another — each adds to the same draft.
4. **Review every change.** When it's done, you get a clear breakdown — how
   many items are new, updated, deleted, or need fixing — plus a preview of
   the actual rows, before anything touches the published graph.
5. **Publish or open a review request**, exactly as you would for any other
   draft change.

### Choosing a reconcile mode

| Mode | What it does | Use it when |
| --- | --- | --- |
| **Add & update** | Creates new items and updates the ones that match. Never deletes anything. | The safe default — you're adding or correcting data. |
| **Replace (authoritative)** | Treats the file as the *complete* picture — anything in the graph but missing from the file gets deleted. | You're re-uploading a full, canonical export and want the graph to match it exactly. |

> **Warning:** Replace mode can delete data. {brand} always shows you the exact
> count before you confirm, but double-check your file is complete before
> choosing it.

Because an import lands on a draft, nothing is final until you publish or it's
merged through review — you can inspect, adjust, or abandon it like any other
set of changes.

---

## Exporting data

Export gives you a complete, **re-importable** copy of the graph — a real
backup, not just a report.

- **Choose what to export**: the whole data source, or just the View you have
  open.
- **Choose which version**: your own working draft, or the published version
  everyone else sees.
- **Choose a format**: the same five formats Import accepts — Excel is the
  best choice if you plan to edit it afterward.

Before anything downloads, {brand} checks what the export will hold. If it
would hold nothing — say, none of the entities a View places are in this data
source — it tells you why instead of downloading an empty file. Then your
browser downloads the file **while it is being written**, so an export of any
size starts at once and shows its progress in your browser's downloads, and
you can close the dialog while it runs. A whole data source of several
gigabytes takes a few minutes.

An export can always be brought back in through Import later, so it doubles
as a safety net before a big change and as a way to work with your data
outside {brand}.

### Data sources without version control

Export works here too, in View mode as in Edit mode: it reads the data
source's graph as it stands — every entity and relationship — as a **cold
copy**. Its rows carry each entity's URN rather than {brand}'s own identity
columns, so importing the file into a data source with version control (this
one, once version control is on, or another) matches the entities by URN.
Changes made to the graph while the file downloads may or may not be in it.

### Limits

| Limit | Why |
| --- | --- |
| **Excel**: 1,048,575 rows per sheet (Nodes and Edges) | Excel's own limit. A larger export offers CSV instead, before anything downloads. |
| **Import**: 100 MB per file | Uploads pass through the same proxies as every request. |
| **Several exports at once** | Each server runs two exports at a time. Another waits for its turn, for up to 15 minutes: your browser shows the download once it begins. If no turn frees up, the download fails; try again later. |

CSV and TSV exports start with a UTF-8 byte-order mark, so Excel reads names
with accents and other non-ASCII characters correctly. Import handles files
with or without one.

---

## Moving views between environments

A View built in one environment can be brought into another where the same data
source is onboarded — build it in dev, check it in UAT, promote it to
production — without rebuilding it by hand.

| File | Holds | Use it when |
| --- | --- | --- |
| **View file** (`.view.json`) | The View's design: layers, placements, rules, display rules, settings, name, and its version history | The data is already there — the usual case |
| **View with its data** (`.view-package.zip`) | The design, plus the entities and relationships it shows (or the whole data source) | The data isn't there yet, or the View and its data should go live together |

Neither carries sharing, favourites or who can see the View: those belong to the
environment it lands in.

### Exporting a View

1. **Export** from the View's header, **Export…** on its card in the Explorer, or
   select several in the Explorer (or a workspace's Views manager) and choose
   **Export**. On the canvas, **Import / Export → This view** has the same actions.
2. **Choose the version**: the current design, or an earlier one. Unsaved
   changes are saved as a new version first, so the file always matches a
   version you can find again.
3. **Choose what goes in**: **View only**, or **View + data**. With data, choose
   whose data — just this View's entities, or the whole data source — and
   whether it's the published data or your draft. View + data needs version
   control on the data source.
4. **Download.** Every file carries a fingerprint of the design, so the
   environment that imports it can tell whether it was changed on the way.

### Importing a View

Choose **Import view** in the Explorer or a workspace's Views manager, or drop
the file anywhere on the Explorer page.

1. **File.** See what's in it — the View, its version, where it came from, and
   whether it's exactly what was exported — and choose what should happen:
   - **Update** the View that's already here, if it came from this one before
     (recommended when it did),
   - **Create a new View**, or **import a separate copy**,
   - or **overwrite** another View you can edit.
2. **Target.** Pick the data source it goes into. {brand} suggests the one that
   holds the same graph, measured on a sample of the View's own entities
   ("49 of 50 found here").
3. **Match.** Every entity the View places is looked up there, and you get a
   match percentage. Anything not found is **kept, marked "not found"** — it
   comes back to life if the entity appears later — or you can drop it, or remap
   it to another entity: **Remap** searches the data source for it by name (or
   takes a pasted URN). Types that don't exist there can be mapped to one that
   does, and you're told if the data source's ontology isn't the one the View
   was exported with. If everything matched, **Skip to review**.
4. **Adjust and review.** Rename it, change its description or anything else in
   the usual wizard steps, then import. The import is saved as a version, with
   where it came from and how well it matched.

When the View is already here, the import says how the two stand — the file is
newer, the View here has moved on, or both changed — and offers **Replace**
(take the file's design) or **Merge** (keep your changes here, the file wins
where both changed the same thing).

A file of several Views imports them together: choose where each source goes,
check them all at once, then review each one — create, update, copy, overwrite
another View, or skip. A type that's missing where the Views land is mapped once
for every View from that source.

> **Tip:** On a data source under version control, an import can **wait in a
> draft**: the new View, or the update, goes live when the draft is published or
> its review request merges, and stays private until then. It's the default where
> you can open drafts, and the draft's review shows the View beside any data
> changes. Choose **Submit for review** when the import finishes to send the draft
> straight to review; from a file of several Views, each waits in its own draft,
> and **Submit for review** sends them all, one review each.

### Importing a View with its data

Drop a `.view-package.zip` in the same place. The journey is the same, with one
more step:

- **Data.** The package's data goes into a **new draft** of the data source you
  chose — it only adds and updates, never deletes, and nothing is live yet. You
  see how many entities are new, updated or unchanged, and anything that couldn't
  be applied.
- **Match** then checks the View against that draft, so the entities the data just
  brought count as found, and the View goes into the **same draft**. Publish the
  draft, or send it for review, and the View and its data go live together.

Only a data source under version control can take the data. To bring in just the
View — for example where the data is already there — choose **View only** on the
File step. A package of several Views brings its data with one of them; import
the others from the same file with **View only**.

> **Note:** Moving Views between environments is a preview. If **Export** or
> **Import view** is missing, your administrator hasn't turned it on (Admin →
> Features → **View versions, import and export**), or has turned one direction
> off (**Export views** / **Import views**).

---

## Where to next

- Understand what happens after you upload — drafts, review, and publishing → [Versioning & Change Control](/guide/versioning-change-control)
- Day-to-day data source management → [Workspace Admin](/guide/workspace-admin)
