# Versioning & Change Control

*For Builders who change data, and anyone who reviews or rolls back changes.*

Version control is how the graph's **data** changes safely: you edit in a
draft, someone can review it, it is published, and every published
change stays in a history you can undo or roll back. This page explains what
it gives you, how it is switched on, and the path through this part of the
guide.

> **Note:** *The one-sentence model* — editing a graph works like editing a
> shared document with track changes: you draft, someone reviews, it publishes,
> and nothing is ever silently lost.

## What version control gives you

- **Edit safely in drafts.** Your changes stay in a draft until they are
  published. The live graph — what {brand} calls **Published**, the version
  everyone sees — is never touched by work in progress. A draft is **public**
  (everyone who can see the data source sees it, and everyone who can edit it
  can change it) or **private** (its owner, the people added to it and its
  reviewers).
- **Review before anything ships.** Raise a change for review, see exactly what
  moves, resolve conflicts, then merge.
- **Full history, and a way back.** Every publish is a revision you can
  inspect, undo on its own, or roll the whole graph back to.

Version control covers the graph's entities and relationships. It is not the
same as the versioning of a [semantic layer](/guide/semantic-layer) (the
meaning of your types), or the
[versions of a View's design](/guide/managing-views#go-back-to-an-earlier-version-of-a-view)
(its layers and settings).

## Is it turned on? Two levels

Version control is switched on at two levels, and both must be on before you
can edit a data source.

| Level | Who controls it | Where | Default | While it's off |
| --- | --- | --- | --- | --- |
| **The whole deployment** | Your administrator | **Administration → Features → Version control** | On | Every version-control surface is hidden and canvases are view-only: no drafts, no reviews, no publishing, no blank models. Existing history is kept, and switching it back on restores everything as it was |
| **Each data source** | Anyone who can manage the workspace's data sources (the **Workspace member**, **Data engineer** and **Workspace admin** roles) | On the canvas, or the data source's **Versioning** tab | Off until someone turns it on (a model built from scratch has it from the start) | The data source can be read, explored and exported, but not edited: **Edit** says *Version control isn't set up for this data source yet* |

A third switch, **Administration → Features → Edit mode** (on by default),
decides whether anyone may change entities and relationships at all. With it
off, Views are read-only and the server refuses any change to a node or edge,
even in a draft.

> **If you see "Reviews are turned off":** the deployment-wide **Version
> control** switch is off. Ask your administrator.

### Turn on version control for a data source

*For people who can manage the workspace's data sources.*

1. Open a View built on the data source. A strip above the canvas says
   **Version control is off for this data source**. (Or open **Workspaces**,
   choose the workspace, select the data source on the **Data Sources** tab, and
   open its **Versioning** tab — it says **Version control is off**.)
2. Choose **Enable version control**. The **Turn on version control** dialog
   opens on **What it means**: what version control gives you, and what
   happens to changes another tool writes straight to the graph (see **If
   another tool keeps writing to the graph**, below). Choose **Continue**;
   the dialog then says how much it will copy into the version history.
3. Choose **Turn on version control**. The strip shows the copy's progress —
   *N of M items copied*. You can keep using the graph while it runs, and
   nothing changes until every item has been checked against the source.
4. When it finishes, the strip says **Everything checked out**: *Your graph is
   now under version control — and we verified the copy against the source
   before switching it on.* Choose **Done**.

If some identifiers (URNs) belong to more than one item, the copy pauses before
copying anything and the strip says **Some identifiers are used more than once**.
It shows how many, which copy of each it would keep (the one synced most
recently), a **Download full list (CSV)** button, and a warning when other data
sources read the same graph. Someone who can manage the data sources then
chooses **Collapse *N* duplicates and continue**, **Re-check source** after
fixing them at the source, or **Give up**.

If the data source names its items by another property than `urn` — an `id`,
say, set as its identity property — the copy first gives each item a `urn` from
it, because version history tells items apart by `urn`. Each one also gets a
`urnSource` saying where it came from. An item with no identifier at all stops
the copy before anything is copied, and the strip says how many: give them one,
then start over.

Turning version control on doesn't change your existing data, except in two
ways. Collapsing duplicates removes the extra copies from the graph itself, for
every data source that reads it. And items given a `urn` keep it. **Give up**
undoes neither. If the copy stops part-way, the strip explains why and offers
**Resume** or to start over.

![The canvas strip after turning on version control: 'Everything checked out', the list of passed checks, and the View history and Done buttons](/docs-assets/guide/versioning-change-control-enable.png)

**If another tool keeps writing to the graph.** Something outside this app (an
ETL job, say, or a connector) may keep writing to the data source's graph after
version control is on. What it writes stays in the graph and shows in views, but
it isn't in the version history. The data source's **Versioning** tab says so
under **Not in history**: how many items and connections, or that the tool
reported a change. Someone who can publish chooses **Bring into history** to take
it in as one published change. It adds and updates items; it never removes
anything from the version history. **Rebuild** on that tab writes what version
history holds back into your own graph: items' fields go back to their values in
history, and nothing else in the graph is removed. **Not in history** counts what
the tool adds: if it also removes items the version history holds, as many as it
adds, nothing shows there. **Check sync** lists such missing items, and
**Rebuild** puts them back.

## The life of a change

```mermaid
flowchart LR
  A["Edit an entity<br/>or relationship"] --> B["Stage changes"]
  B --> C["Review & Save"]
  C --> D["Your draft"]
  D --> E["Submit for review"]
  E --> F["Review Center"]
  F -->|Merge| G["Published + history"]
  D -->|"Publish now"| G
  G --> H["Undo or Restore"]
```

1. **Edit** — in a draft, change an entity or relationship in its drawer, or
   add and connect entities on the canvas.
2. **Stage changes** — keep the edit for review. Nothing is saved yet.
3. **Review & Save** — check your staged edits and save them to the draft as
   one save point.
4. **Publish** your draft — **Submit for review**, or **Publish now** if you
   don't need a review.
5. **Review Center** — a reviewer checks the changes, pulls in newer published
   work if needed, and **Merge**s it, or **Dismiss**es it.
6. **History** — every merge or publish becomes a revision you can undo or roll
   back to.

## Follow the track

Read these in order the first time; afterwards, jump to what you need.

1. [Editing in a Draft](/guide/editing-in-a-draft) — start a draft, change
   entities and relationships, Review & Save, and submit your draft for review.
2. [The Review Center](/guide/review-center) — find the requests waiting for
   you, check what they change, and merge or dismiss them.
3. [Import & Export](/guide/import-export) — make many changes at once from a
   file, and take backups out.
4. [Undo vs. Restore](#undo-vs-restore--the-distinction-that-matters), on this
   page — fix a mistake that has already been published.

## Words you will see

| On screen | Means |
| --- | --- |
| **Published** | The live version of the graph that everyone sees |
| **Draft** | A working copy where your changes wait until they're published |
| **Stage changes** | Keep an edit for **Review & Save** — nothing is saved yet |
| **Review & Save** | Save your staged edits to your draft |
| **Publish** | Send your draft to **Published** — through a review, or directly |
| Review request / merge request | A draft submitted for someone to check and merge |
| **Merge** | Apply a reviewed request to **Published** |
| **Get latest updates** / **Pull latest** | Bring newer published changes into a draft that has fallen behind |
| Revision | One published change in the history |
| **Fork** | A copy of a data source's graph to work in, with its own drafts and history |
| **Update from parent** | Take the newer changes of the data source a fork came from into the fork |
| **Propose to parent** | Open a review of a fork's changes into the data source it came from |

More terms are in the [Glossary](/guide/glossary).

## See the history

1. Open a View on a data source with version control.
2. In the View's header, choose **Reviews**. The **Changes & Reviews** panel
   opens — on **Changes** if you're in a draft, on **Commits** if you're on
   **Published**.
3. On **Commits**, choose the scope: **This draft**, **This view** (changes made
   from this View) or **Whole graph**. Select a revision to see its changes.

After a merge or publish, the banner *Merged — your changes are now live* (or
*Published — …*) offers **View in history** too. A data source's **Versioning**
tab lists its recent commits, drafts and open merge requests.

The history is listed newest first, by month and day, and keeps loading older
revisions as you scroll — all the way back to the first.

### See the graph as it was

> **Preview.** This needs **Revision history viewer: the graph as it was** turned
> on under Admin → Features. While it is, the **Commits** tab is called **History**.

Like checking out an earlier commit, you can open the published graph as it was at
any revision, read-only, and compare any two revisions.

1. In **Reviews → History**, open a revision's **⋯** menu and choose **Open on
   canvas**. Or choose **Months** to go to the end of any month or day: darker
   months saw more revisions.
2. The canvas shows the graph as it was. The banner above it says when that was,
   which revision it is and who made it, and how much has changed since.
3. Choose **Back to Published** (or press **Esc**) to return to the graph as it is now.

While a past revision is open:

- **Nothing can be edited**, and search, traces, Narrow, display rules and subset
  views are off: they read the graph as it is now.
- **The layout is today's**: the view's layers and the ontology as they are now.
- **Exporting** downloads the graph as it was.
- **The address in your browser** (`?rev=…`) opens the same revision for anyone
  who can read the data source. **Copy link** on a revision gives you one.

To compare, choose **Compare with now** (on a revision or in the banner) or
**Compare with…** and then the other revision. You see how much was added,
modified and removed, over how many revisions and by whom, which types changed
most, and every change. **Highlight on canvas** rings them on the graph.

A revision more than 100,000 changes back is too far to draw. It opens as a
comparison with now instead, and you can still export the graph as it was then.

## Undo vs. Restore — the distinction that matters

Two different tools fix a published mistake, and they're not interchangeable.
Both add a **new** revision to the history rather than erasing anything, so
nothing is ever truly destroyed.

| | **Undo just this change** | **Restore graph to here** |
| --- | --- | --- |
| **What it does** | Reverses *one* published revision | Resets the *whole graph* to how it looked at the chosen revision |
| **Later work** | Kept — only the chosen revision is reversed | Rolled back along with everything else after that point |
| **Can it conflict?** | Yes — if a later revision changed the same items, it stops and offers to restore instead | No — it can't conflict, by design |
| **Use it when** | You know exactly which change was wrong, and other work since then should stay | You need to get back to a known-good state, whatever has happened since |

To use either:

1. Open the history (**Reviews → Commits**, scope **This view** or **Whole
   graph**).
2. On the revision, open the **⋯** (**Revision actions**) menu.
3. Choose **Undo just this change** or **Restore graph to here**.
   - *Undo this change?* shows the revision and reminds you that later changes
     are kept. Choose **Undo change**.
   - *Restore the graph to this point?* works out the exact impact first — how
     many later revisions it rolls back and how many items are updated, removed
     or brought back. Choose **Restore**.
4. A notification confirms that a new revision was added to the history.

If **Undo** can't apply cleanly, the dialog says *This change can't be undone on
its own*, names the items a later revision changed again, and offers **Restore
to just before it instead**.

A merged review request offers the same undo from the Review Center: **Revert
this merge**.

Undo and Restore are for people who can manage the workspace's data sources —
the same people who can merge. They are not offered on the **This draft** scope:
a draft that's wrong is simply discarded.

> **Tip:** If in doubt, Undo first. It's the narrower, safer tool. Reach for
> Restore only when you need to reset everything back to a specific point, or
> when Undo tells you it can't apply cleanly.

## Work in a fork

*When your administrator has turned on **Administration → Features → Forks**
(it is off unless they do).*

A **fork** is a copy of a data source's graph to work in, with its own drafts
and history. It reads the data source it came from — its **parent** — as it
was when the fork was made, takes the parent's newer changes when you ask
(**Update from parent**), and offers its own changes back as a review
(**Propose to parent**). A fork is a data source of its own, in the same
workspace, with its parent's settings.

### Fork a data source

*For people who can manage the workspace's data sources.*

1. Open **Workspaces**, choose the workspace, select the data source on the
   **Data Sources** tab, and open its **Versioning** tab.
2. Under **Forks**, choose **Fork**.
3. Give it a name and choose **Create fork**. Its data source is named after
   its parent and the name — for example *Sales · Q3 restructure*.

The fork appears in the list. If it can't be made — the data source already
has as many forks as it may, or its editing is paused — the dialog says why.

### See how far a fork is from its parent

Each fork in the list shows who made it and when, and **ahead · behind**: the
changes made on the fork since it last merged into its parent, and the
parent's changes it hasn't taken in yet. *Update recommended* means the fork
has fallen far behind, or so far that it reads more slowly; updating fixes it.

**Open** shows the fork's own data source. At the top of its **Versioning**
tab — and above the canvas of a View built on it — a strip says **Fork of**
its parent (a link back), how far it is, and offers **Update from parent**
and **Propose to parent**.

### Take the parent's changes

Choose **Update from parent**. Changes only the parent made simply show up in
the fork; what the fork and its parent both changed is merged. Where they
changed the same thing differently, the conflict dialog opens, as for
**Get latest updates**: for each, keep **Your version** (the fork's) or take
**Incoming** (the parent's), then choose **Merge with resolutions**. A large
update runs in the background: the button says **Updating…** until it is done.

Drafts on the fork then show as behind; bring them up to date with
**Get latest updates**.

### Offer the fork's changes back

1. Choose **Propose to parent**.
2. Give the review a title, a description and reviewers, and choose
   **Open review**. It opens in the [Review Center](/guide/review-center).

If the fork is behind its parent, **Propose to parent** says
*Update from parent first*: its review merges only once the fork has taken its
parent's changes. A fork has one open review at a time; proposing again opens
that one. The fork lives on after its review merges — propose again whenever it
has more.

To remove a fork, choose **Delete** in the list; **Restore** brings it back for
30 days. Close its open review, and delete any forks made from it, first.

> **If you see "Forks are turned off for this deployment":** forks stay listed
> and readable, and can still be deleted and restored, but nothing changes in
> them — **Fork**, **Update from parent**, **Propose to parent**, and approving
> or merging a fork's review, aren't offered. Ask your administrator.

## Who can do what

Version-control actions follow the workspace's data-source permissions, not the
View's sharing.

| Action | Who |
| --- | --- |
| See a data source's history, its public drafts and its Review Center | Anyone who can read the workspace's data. A private draft, and its review, only its owner, its members and its reviewers |
| Turn on version control for a data source | People who can edit the workspace's data sources — the **Workspace member**, **Publisher**, **Data engineer** and **Workspace admin** roles |
| Start a draft, and edit a public one: **Review & Save**, **Submit for review** | The same people. A private draft: its owner and its **Editor** and **Maintainer** members |
| Rename a draft, change who can see it, add members, **Discard draft** | Its owner or a maintainer |
| Hand a draft on | Its owner; a **Workspace admin** for someone who has left |
| **Publish now** (skip review) | Its owner or a maintainer who can also publish — the **Publisher**, **Data engineer** and **Workspace admin** roles. Not where the data source has someone else merge |
| **Merge**, **Pull latest** in the Review Center | People who can publish — and not whoever opened the request, where the data source has someone else merge |
| **Dismiss** | People who can edit the data |
| **Approve** | People who can edit the data, shown on requests that name them as reviewer — whoever opened the request too, unless the data source has someone else approve |
| **Undo just this change**, **Restore graph to here**, **Revert this merge** | People who can publish |
| **Fork** a data source; **Delete** and **Restore** a fork | People who can edit the workspace's data sources |
| **Update from parent** | People who can publish |
| **Propose to parent** | Anyone who can read the fork |
| **Drafts and reviews** settings | **Workspace admins** |
| Switch version control or edit mode off for everyone | Administrators, in **Administration → Features** |

Organisation-wide admin roles can do all of the above in every workspace.

> **Note:** Review can be required. Where a data source has someone other than
> whoever opened a review merge it, drafts are published only through a review
> — see below.

## Drafts and reviews settings

On a workspace's page, **Drafts and reviews** sets, for every data source in it:

- **New drafts start** — **Public** (the default) or **Private**;
- **Drafts may be** — **Public or private**, **Public only** or **Private only**.
  Turning private drafts off leaves existing private drafts as they are;
- **Whoever opens a review may approve it** — **Yes** by default;
- **Whoever opens a review may merge it** — **Yes** by default. With **No**,
  drafts are published only through a review someone else merges.

A data source can set its own on its **Versioning** tab; each setting is its
own or **Use the workspace's setting**. Only workspace admins change them.

**Drafts whose owner left**, below them, lists the open drafts of people who
have left the workspace — their name, owner, level and when they last changed,
never what they hold. Choose **Hand on** to give one a new owner.

## Where to next

- [Editing in a Draft](/guide/editing-in-a-draft) — when you're ready to make your first change.
- [The Review Center](/guide/review-center) — when someone has asked you to review a change.
- [Import & Export](/guide/import-export) — when you need to change many items at once, or take a backup.
- [The Semantic Layer](/guide/semantic-layer) — when you mean the *other* kind of versioning: the meaning of your types.
