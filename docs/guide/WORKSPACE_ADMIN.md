# Workspace Admin

```tour-workspaces
```

*For Administrators.* [Admin Setup](/guide/admin-setup) gets your *first*
workspace running. This page covers what you'll do most days after that:
deciding who can get in, attaching and moving data sources, keeping
aggregation healthy, and keeping an eye on your views, your reviews and your
ontology health.

> **Before you start:** What you can change depends on your role (see
> [Users & Access](/guide/users-access#roles)):
>
> - **Create Workspace** needs the `system:workspaces:create` permission —
>   the **Org Admin** and **Super Admin** roles carry it.
> - The **Members** tab appears only to admins of that workspace
>   (`workspace:admin`) — **Workspace admins**, **Org Admins** and **Super
>   Admins**.
> - Adding, editing and re-aggregating data sources needs
>   `workspace:datasource:manage` — **Workspace admin**, **Data engineer** and
>   **Workspace member** all hold it.

---

## Find your way around a workspace

Open **Workspaces** in the sidebar and select a workspace. Under its header, the
**Quick Links** row jumps to its **Explorer**, its **Schema Editor**, and
**Global Jobs** (**Ingestion → Job History**). Below that are the tabs:

| Tab | Use it to | Who sees it |
| --- | --- | --- |
| **Data Sources** | Attach, edit and move the graphs that feed this workspace | Everyone who can open the workspace |
| **Profiling** | See how each source's entity and relationship counts are changing | Anyone holding a built-in workspace role, Org Admins and Super Admins |
| **Views** | Oversee every view: visibility, owners, bulk changes and publication requests | Everyone who can open the workspace |
| **Aggregation** | Monitor and re-run aggregation for each source | Everyone who can open the workspace (re-running needs data-source permission) |
| **Ontology** | Follow changes to the semantic layers this workspace's sources use | Everyone who can open the workspace |
| **Reviews** | Review merge requests across the workspace's versioned sources | Only while **Version control** is on — it is by default |
| **Members** | Decide who can get in, and with which role | Workspace admins, Org Admins and Super Admins |

> **If you don't see Reviews:** **Version control** is switched off in
> **Administration → Features** — see [Feature
> Switches](/guide/feature-switches). **If you don't see Members:** you aren't
> an admin of this workspace.

---

## Giving people access (the Members tab)

Most people reach a workspace through a **binding**: a user or a group, given
one role in this workspace. A group binding covers every member of the group.
Super Admins can open every workspace without one. Org Admins and Org Auditors
hold rights in every workspace, but a workspace appears in their
**Workspaces** list only once they have a binding into it — **Workspace
viewer** is enough, because their organization-wide role supplies the rest.

1. Open the workspace and select the **Members** tab. (Or, on **Workspaces**,
   hover over the workspace's card and select **Members**.)
2. Select **Add member**. The **Add member** dialog opens.
3. Choose **User** or **Group**, search, and pick one.
4. Under **Role**, choose a role (see the table below). **Workspace member** is
   selected to start with.
5. Under **Access duration**, keep **Permanent**, or choose **24h**, **7d**,
   **30d** or **90d** — access then revokes itself, which suits contractors
   and temporary cover.
6. Select **Add to workspace**.

**You should now see** the user or group in the members list with its role. A
binding with a duration shows how long it has left, in an **Expires in …**
badge.

![a workspace's Members tab with the Add member dialog open, showing the User and Group toggle, the Role list and the Access duration choices](/docs-assets/guide/workspace-admin-members.png)

| If they should… | Give them | Because |
| --- | --- | --- |
| Look, not change | **Workspace viewer** | Read-only: they open the workspace's views and see its data sources. |
| Build and edit views, and look after data sources day to day | **Workspace member** | The everyday contributor role. |
| Own the data — sources, semantic layers, catalog items and views — without managing people | **Data engineer** | Full data control, but no members or workspace settings. |
| Run the workspace — members, settings, deletion and everything inside | **Workspace admin** | Every permission inside this one workspace, none outside it. |

Custom roles your team has created also appear in the list, when they can be
bound in this workspace.

> **Note:** Today, **Add member** works fully only for **Super Admins**. Its
> lists come from elsewhere in the platform: people need the Super Admin role,
> groups need `system:groups:manage` (Org Admins have it), and roles need
> `system:bindings:read`. Every workspace admin can still review members,
> revoke them and approve access requests — so the quickest way to let someone
> in yourself is to have them request access, then approve it (below).

### Seeing who can actually get in

The toggle above the list switches between **Bindings** (what was granted, to
whom) and **People with access** (everyone who can get in, with groups
expanded into their members). Use **People with access** to answer "can Dana
see this workspace?".

### Removing someone

On their row, select **Revoke binding**. A preview shows what they would
lose; select **Revoke binding** again to confirm. Access ends at their next
request.

### Answering access requests

People who can't open a workspace can ask for access — see [Requesting
Access](/guide/requesting-access). Their requests come to the admins of that
workspace, and the **Members** tab is the only place to answer them: a
**Pending access requests** panel appears at the foot of the tab while anything
is waiting, showing who asked, the role they asked for and when.

1. Read the request, including any note the person wrote.
2. Select **Approve** to grant the requested role — or select **Deny**, add an
   optional reason (the requester sees it), and select **Confirm deny**.

**You should now see** the request leave the panel; an approved person
appears in the members list straight away. The requester sees the outcome on
their own **My access** page, under **My access requests**.

> **Tip:** New requests don't arrive in your Inbox. If people tell you they've
> asked for access, look at the **Members** tab of the workspace they asked
> about.

---

## Creating a workspace

From **Workspaces**, select **Create Workspace**. The **Create Workspace**
wizard opens at **Basics**.

1. **Basics** — give it a clear name ({brand} checks for duplicates as you type
   and offers a free alternative, such as "Use “Finance 2” instead", if yours is
   taken) and an optional description.
2. **Data** — optionally connect a catalog item now, or leave **Skip for now**
   selected and add one later. Most sources are given a workspace when they are
   onboarded in **Ingestion**, so this list is often empty; it says **Every data
   source is already allocated** when that is the case.
3. **Review** — confirm, then select **Create workspace**.

**You should now see** "“*name*” is ready". Select **Open workspace** to jump
straight in.

---

## Adding a data source

A workspace isn't usable until it has at least one **data source** — a catalog
item (the graph), normally bound to a semantic layer (its meaning). On the **Data
Sources** tab, select **Add Source** (or **Add First Source** in an empty
workspace). The **Add Data Source** wizard opens at **Source**.

1. **Source** — pick which catalog item to attach, and optionally give it a
   **Label** — what it's called inside this workspace.
2. **Semantics** — choose the semantic layer. {brand} ranks the available
   layers by how much of the graph's actual types they cover, and marks the
   best match for you — so you're not guessing which one fits. **System
   defaults** classifies the data with the built-in types instead.
3. **Review** — confirm and select **Add data source**.

**You should now see** "“*name*” is attached". Nothing is aggregated yet — run
it from the **Aggregation** tab when you're ready (see below).

> **Note:** Aggregation needs a semantic layer. A source left on **System
> defaults** isn't aggregated until you assign a layer: select the source on
> **Data Sources**, select **Edit**, choose a **Semantic layer (ontology)**, then
> **Save changes**.

---

## Moving a data source between workspaces

Teams reorganize, and data sources sometimes need to move with them. The same
Add Data Source wizard handles this: pick a source that already belongs to
another workspace, and the wizard switches into **move mode** — its title
becomes **Move Data Source** and the final button **Move it here**.

> **Warning:** A data source can only move if nothing is built on it. If any
> Views exist against it in its current workspace, it isn't offered as movable —
> you'll see it listed but disabled, with a note showing how many Views
> depend on it. This protects those Views from breaking out from under
> their owners.

Sources that *are* eligible show a clear **Move** badge, along with which
workspace currently holds them. Moving one takes its aggregation state and
stats with it — the members of its old workspace simply lose access, and the
new workspace gains a fully working data source, not a blank slate.

---

## Running and monitoring aggregation (the Aggregation tab)

**Aggregation** pre-computes rolled-up lineage so deep lineage queries stay
fast. The **Aggregation** tab shows every source in the workspace and lets you
re-run it. Status updates live while a job is running.

1. Open the workspace and select **Aggregation**. The **Aggregation Overview**
   lists each data source with its status: **Ready**, **Running**, **Pending**,
   **Failed**, **Skipped** or **Not Started**.
2. To narrow the list, select a status chip such as **2 Failed**; select **All**
   to clear it.
3. To re-run one source, select **Re-trigger** on its card. (While a job is
   running or queued, the button reads **Job Active**.)
4. To see past runs, select **Job History** on the card.

**You should now see** the source move to **Pending**, then **Running**, then
**Ready**.

What the warnings on a card mean:

| Warning | What to do |
| --- | --- |
| **Drift detected** — source data has changed since the last aggregation | Select **Re-trigger** to bring it up to date. |
| **Aggregation predates depth stamps** | Re-trigger it — or select **Rebuild all aggregations** at the top, which also shows how many sources **need it**. |
| **Connections not up to date** | Re-aggregating won't fix this one — as the card says, check the source's version control. **Administration → Infrastructure** lists any **Graphs not publishing**. |
| A failed job's error message | Fix the cause it names, then **Re-trigger**. |

**Purge** (shown on a **Ready** source) removes that source's aggregated edges
after you confirm **Purge all edges?**. You need it before switching a source to
a different aggregation strategy — which you do on the source's own
**Aggregation** tab (select it on **Data Sources**): purge, switch, then
re-trigger. For platform administrators, the **Workers** panel shows the
aggregation workers online and the queue, with **Defaults** for fleet-wide
tuning.

For aggregation and freshness across *every* workspace, use **Ingestion → Job
History** and **Ingestion → Freshness** — see [Data Freshness &
Ingestion](/guide/data-freshness).

---

## Governing your Views (the Views tab)

Every workspace has a **Views** tab built for oversight, not just browsing:

- **At a glance**: total Views, how many you own, how many distinct owners
  there are, and the last activity and who did it.
- **Filter by visibility** — **Private**, **Workspace** or **Enterprise** — or
  select **Need attention** to jump straight to Views that need a look.
- **Search, filter by data source or owner, and sort**, in either a grid or a
  detailed list.
- **Bulk actions** — change the visibility of several Views at once, or
  delete a batch you've confirmed are safe to remove.

### Answering publication requests

Publishing a view to **Enterprise** makes it, and read-only access to its data
source, visible to everyone signed in. People who hold the publish permission
in this workspace — and workspace admins — see a **Publication requests**
panel on the **Views** tab.

1. Read the request: which view, who asked, and which data source it would
   expose.
2. Select **Approve**, then **Publish to everyone** to confirm — or select
   **Decline**, add an optional reason (the asker sees it), and select **Confirm
   decline**.

Workspace admins also choose, under **Publishing to everyone**, whether
**Members must request approval** or **Members can publish directly**, and can
mark individual data sources as always needing a publisher's approval. Who can
see what is explained in [Who can see a View](/guide/managing-views#who-can-see-a-view).

### Per-view activity history

Open any View's menu and select **Activity** to see a full, day-by-day
timeline of what happened to it — created, edited, shared, its visibility changed, or its
underlying data updated — each entry naming who did it and, for edits, what
specifically changed. Filter by channel (Data / Settings / Sharing) or by
person when you need to answer "who changed this, and when."

---

## Watching what changed (the Profiling tab)

**Profiling** answers "what moved, and by how much?" across the workspace's
sources, from counts {brand} collects in the background.

1. Open the workspace and select **Profiling**.
2. Pick a time window — **24 hours**, **7 days** (the default), **30 days** or
   **90 days** — and what to measure: **Entities**, **Relationships**, or
   **Entities + relationships**.
3. Read the summary — **Sources reporting**, the current total, **Need a look**
   and **Not observed** — then the table, which lists unusual movement first.
4. Select a source to open its own profile.

A source that wasn't observed in the window is counted under **Not observed**,
never listed at zero — it didn't drop to nothing. [Data Freshness &
Ingestion](/guide/data-freshness) covers profiling across every workspace.

---

## Reviewing changes (the Reviews tab)

When **Version control** is on, edits to a versioned data source are made in a
draft and merged through a **merge request**, like a pull request. The
**Reviews** tab gathers every merge request across the workspace's sources.

1. Open the workspace and select **Reviews**.
2. Read the summary cards — **Open requests**, **Ready to merge**, **Needs
   attention** and **Raised by you**.
3. Switch between **Open**, **Raised by you** and **All**, search by title,
   branch or author, or filter by **Status**, **Author** or **Source**.
4. Select a request to open it and review its changes.

[The Review Center](/guide/review-center) explains reviewing, resolving
conflicts and merging in full; [Editing in a Draft](/guide/editing-in-a-draft)
covers the other side.

---

## Checking ontology health

The **Health** tab of a semantic layer (**Semantic Layers** → open the layer →
**Health**) answers a narrower but important question: *does the data in your
graph actually match what your ontology declares?* It checks every data source
the layer is assigned to, and classifies every type as:

| Status | Meaning |
| --- | --- |
| **Exact** | The data matches your ontology's naming exactly. |
| **Case drift** | The data is there, but the capitalization doesn't match — so it's silently invisible to anything that depends on exact naming. |
| **Unmapped** | The data doesn't correspond to anything in your ontology at all. |

The tab leads with a plain verdict — **Fully aligned**, or **Needs attention**
with a count of what's drifted or unmapped — before you drill into any detail,
and it works from data collected periodically, not a live query, so it's fast
to check. Case drift is usually the easy win: {brand} aligns it to the declared
spelling for you, so you don't need a manual data fix. The workspace's own
**Ontology** tab shows a timeline of changes to the layers its sources use.

---

## Where to next

- [Users & Access](/guide/users-access) — when you want to choose the right
  roles, use groups, or invite people.
- [Data Freshness & Ingestion](/guide/data-freshness) — when aggregation fails
  or data looks out of date.
- [The Semantic Layer](/guide/semantic-layer) — when you want to understand or
  improve a layer.
- [The Admin Console](/guide/governance-ops) — when you want to keep the whole
  platform healthy.
