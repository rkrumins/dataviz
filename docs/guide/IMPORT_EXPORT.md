# Import & Export

*For Builders and Administrators.* Bring data in from a spreadsheet, or take a
full backup out — both go through the same **draft-and-review** safety net as
any other change, so a bad import can never silently corrupt your graph.

> 💡 **The one-sentence model:** Import stages changes on a draft for you to
> review before anything publishes; Export gives you a complete,
> re-importable copy of the graph whenever you need one.

---

## Where to find it

Look for the **Import / Export** menu in the header, in either View or Edit
mode. **Export** always works. **Import** needs an open draft — if you're not
already in Edit mode, the menu tells you to start one first. (If your data
source doesn't have version control turned on, Import won't appear at all —
see [Versioning & Change Control](/guide/versioning-change-control).)

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
   while it processes.
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

> ⚠️ **Replace mode can delete data.** {brand} always shows you the exact
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

An export can always be brought back in through Import later, so it doubles
as a safety net before a big change and as a way to work with your data
outside {brand}.

---

## Where to next

- Understand what happens after you upload — drafts, review, and publishing → [Versioning & Change Control](/guide/versioning-change-control)
- Day-to-day data source management → [Workspace Admin](/guide/workspace-admin)
