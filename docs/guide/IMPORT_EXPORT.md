# Import & Export

*For Builders and Administrators.*

Bring data in from a spreadsheet, take a full, re-importable backup out, or
move a View to another environment. This page tells you what each one needs,
then walks you through it. An import goes through the same **draft-and-review**
safety net as any other change, so a bad file can never silently corrupt your
graph.

> **Note:** *The one-sentence model* — Import stages changes on a draft for you
> to review before anything publishes; Export gives you a complete,
> re-importable copy of the graph whenever you need one.

---

## What needs version control

Some of this works on any data source; importing data needs
[version control](/guide/versioning-change-control), because an import always
lands in a draft.

| You want to… | Without version control | You also need |
| --- | --- | --- |
| [Export data](#exporting-data) | Works — you get a *cold copy* of the graph as it stands | The **Export graph data** switch (on by default) |
| [Import data](#importing-data) | Not available | Version control on, for the deployment and the data source, and permission to manage the workspace's data sources |
| [Move a View](#moving-views-between-environments) as a View file | Works | The **View versions, import and export** preview, and **Export views** / **Import views** |
| [Move a View with its data](#importing-a-view-with-its-data) | Not available | Version control on the data source it comes from and the one it goes to, the same switches, and **Export graph data** |
| [Share display rules and saved searches](#view-libraries-rules-and-saved-searches) | Works | Permission to edit the View you import into |

All of these switches are in **Administration → Features**.

---

## Where to find it

Importing and exporting data happens on a **Context View**: open the **Import
/ Export** menu in its header (two arrows — the words show only on very wide
screens).

- **Export…** is there whenever **Export graph data** is on — on Published and
  in a draft, with or without version control.
- **Import…** is there whenever **Version control** is on for the deployment,
  but it works only in a draft. Outside one it's greyed out: *Available in Edit
  mode — start a draft to import.* See
  [Start editing](/guide/editing-in-a-draft#start-editing). On a data source
  without version control you can't start a draft, so
  [turn version control on](/guide/versioning-change-control#turn-on-version-control-for-a-data-source)
  first.
- Under **This view**, the same menu moves the View itself — **Export view…**,
  **Export view + data…** and **Update this view from a file…** — when your
  administrator has turned View files on. See
  [Moving views between environments](#moving-views-between-environments).

---

## Importing data

Import is built for bulk changes — onboarding a new system's worth of tables,
correcting a batch of metadata, or loading a one-off dataset — without hand-
editing dozens of nodes on the canvas.

1. Open a Context View on the data source and choose **Edit** to start or
   continue a draft.
2. Open **Import / Export** and choose **Import…**. The **Import data** dialog
   opens, with *How importing works* on the left.
3. **Download a starter template** — it's prefilled with your current data, so
   you learn the columns straight away — or use your own file. Excel, CSV, TSV,
   NDJSON and JSON are all supported (older formats like `.xls` or Numbers files
   aren't — save as CSV first).
4. Edit the file anywhere — a spreadsheet, a script, whatever's convenient.
   Each property is its own column; add a `prop.<name>` column for a new one.
5. Back in the dialog, drop the file in (or click to browse). The **File
   format** is detected for you.
6. Under **How should it reconcile?**, choose **Add & update** or **Replace
   (authoritative)** — see [Choosing a reconcile mode](#choosing-a-reconcile-mode).
7. Choose **Import**. A CSV, TSV or NDJSON file can be up to 10 GB; a JSON or
   Excel file, which is read whole, up to 100 MB. The dialog shows how much of
   the file is up. If the upload stops (a dropped connection, a closed tab),
   choose the same file again and it picks up where it left off. The import
   then runs in the background, so you can keep working. When the server is
   busy with other imports and exports, yours waits its turn, and the dialog
   says how many are ahead of it. A multi-GB import takes a while: allow about
   an hour for every 5 million rows.
8. When it's done, you get a breakdown — how many items are new, updated,
   deleted, or need fixing — and a preview of the actual rows. Nothing has
   touched Published. Choose **Review changes**: the **Changes & Reviews**
   panel opens on **Changes**, listing everything the import put in your draft.
9. Publish the draft, or submit it for review, exactly as you would for any
   other change — see
   [Submit your draft for review](/guide/editing-in-a-draft#submit-your-draft-for-review).

**Import another** brings in a second file; each import adds to the same draft.
If an import fails, **Try again** takes you back to choose the file.

New top-level entities that an import creates are placed in the View's layers,
so you see them on the canvas straight away.

### Choosing a reconcile mode

| Mode | What it does | Use it when |
| --- | --- | --- |
| **Add & update** | Creates new items and updates the ones that match. Never deletes anything. | The safe default — you're adding or correcting data. |
| **Replace (authoritative)** | Treats the file as the *complete* picture of the View you're importing from: its entities missing from the file are deleted. The rest of the data source is untouched. | You're re-uploading a full, canonical export of the View and want it to match exactly. |

> **Warning:** Replace mode can delete data. {brand} always shows you the exact
> count before you publish, but double-check your file is complete before
> choosing it.

Because an import lands on a draft, nothing is final until you publish or it's
merged through review — you can inspect, adjust, or abandon it like any other
set of changes.

---

## Exporting data

Export gives you a complete, **re-importable** copy of the graph — a real
backup, not just a report. Anyone who can read the workspace's data can export
it.

1. On a Context View, open **Import / Export** and choose **Export…**. The
   **Export data** dialog opens.
2. If you're in a draft, choose **Which version**: **My working branch**
   (includes your draft changes) or **Published** (what everyone else sees).
3. Choose **What to export**: **This view** (only what the View contains) or
   **Whole data source** (every entity in the graph).
4. Choose a format: the same five formats Import accepts — **Excel** is the
   best choice if you plan to edit it afterwards. For a spreadsheet format you
   can also **Add new property columns** to fill in.
5. Choose **Export** with the format's name — for example **Export XLSX**.

Before anything downloads, {brand} checks what the export will hold. If it
would hold nothing — say, none of the entities a View places are in this data
source — it tells you why instead of downloading an empty file. Then the
server **prepares the file**, up to 50 GB: the dialog shows its place in the
queue, then how far it has got, and your browser downloads it once it's ready.
You can close the dialog meanwhile: open it again and it picks the export up
where it is. If the download breaks off, your browser can resume it from where
it stopped, and the file is kept on the server for a day. A few hundred
thousand entities take seconds to prepare; tens of gigabytes take hours.

An export can always be brought back in through Import later, so it doubles
as a safety net before a big change and as a way to work with your data
outside {brand}.

### Data sources without version control

Export works here too: it reads the data source's graph as it stands — every
entity and relationship — as a **cold copy**, which your browser downloads
while it is read. Its rows carry each entity's URN rather than {brand}'s own
identity columns, so importing the file into a data source with version
control (this one, once version control is on, or another) matches the
entities by URN. Changes made to the graph while the file downloads may or may
not be in it.

### Limits

| Limit | Why |
| --- | --- |
| **Excel**: 1,048,575 rows per sheet (Nodes and Edges) | Excel's own limit. A larger export offers CSV instead, before anything downloads. |
| **Import**: 10 GB per CSV, TSV or NDJSON file; 100 MB per JSON or Excel file | A JSON or Excel file is read whole. A larger file can be split and imported in parts, each adding to the same draft. |
| **Export**: 50 GB per file | Preparing one that size takes hours. |
| **Several exports at once** | Exports take turns on the server. One being prepared waits in the queue, and the dialog shows how many are ahead of it. A data source without version control runs two exports at a time on each server: another waits for up to 15 minutes, then fails; try again later. |

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
   select several in the Explorer (or on a workspace's **Views** tab) and choose
   **Export**. On a Context View, **Import / Export → This view** has the same
   actions.
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

Choose **Import view** in the Explorer or on a workspace's **Views** tab, or
drop the file anywhere on the Explorer page.

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
> you can open drafts, and the draft's review in the
> [Review Center](/guide/review-center) shows the View beside any data changes.
> Choose **Submit for review** when the import finishes to send the draft
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
> **Import view** is missing, your administrator hasn't turned it on
> (**Administration → Features → View versions, import and export**), or has
> turned one direction off (**Export views** / **Import views**).

---

## View libraries: rules and saved searches

A View's [display rules](/guide/display-rules) and the
[searches saved for everyone](/guide/advanced-search#saving-and-sharing-searches)
on it make up its **library**, which travels on its own as a small file,
`<view name>.library.json` — from one View to another, in this environment or
the next. A View file carries the display rules but not the saved searches, so
this is how those move. Libraries don't need version control.

- **Export** it from the bottom of the Property Manager's **Display rules** tab,
  or with **Export library** at the bottom of Advanced Search's **Library**.
  Anyone who can open the View can.
- **Import** it the same way (**Import…** / **Import library…**) into a View you
  can edit. Choose **Add what's new**, **Add everything** or **Replace**, and
  check the item-by-item preview before anything changes.

There is no library for a whole data source: every View keeps its own. To give
every View of a data source the same rules and searches, someone who can edit
those Views can run the publish script in the
[Search & Display Rules Reference](/docs/feature-search-and-rules-reference#publish-a-pack-to-every-view-of-a-data-source).

---

## Where to next

- [Editing in a Draft](/guide/editing-in-a-draft) — when you want to check or adjust what an import put in your draft, then submit it.
- [The Review Center](/guide/review-center) — when an import is waiting for someone to review and merge it.
- [Versioning & Change Control](/guide/versioning-change-control) — when you need version control turned on, or want to undo a published import.
- [Display Rules](/guide/display-rules) — when you're moving display rules and saved searches in a library file.
