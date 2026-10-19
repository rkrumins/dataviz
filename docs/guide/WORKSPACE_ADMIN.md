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
> - The **Members** tab appears to the people who let others into that
>   workspace (`workspace:members:add`) — its **Workspace admins** and
>   **Workspace stewards**, **Org Admins** and **Super Admins**. Removing
>   people and choosing how people get in stay with admins (`workspace:admin`).
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
| **Members** | Decide who can get in, with which role, and answer their requests | Workspace admins and stewards, Org Admins and Super Admins |
| **Activity** | See who ran, changed or granted what in this workspace — when, and why | Workspace admins, Org Admins, Org Auditors and Super Admins |

> **If you don't see Reviews:** **Version control** is switched off in
> **Administration → Features** — see [Feature
> Switches](/guide/feature-switches). **If you don't see Members:** you aren't
> an admin or steward of this workspace.

---

## Giving people access (the Members tab)

Most people reach a workspace through a **binding**: a user or a group, given
one role in this workspace. A group binding covers every member of the group.
Super Admins can open every workspace without one. Org Admins and Org Auditors
hold rights in every workspace, but a workspace appears in their
**Workspaces** list only once they have a binding into it — **Workspace
viewer** is enough, because their organization-wide role supplies the rest.

Two kinds of people look after who gets in:

| Role | Can | Can't |
| --- | --- | --- |
| **Workspace admin** | Add users and groups at any workspace role whose permissions they hold, answer requests, remove people, and choose [how people get in](#how-people-get-in) | — |
| **Workspace steward** | Add people as **Workspace viewer** or **Workspace member**, and answer requests at those levels — otherwise a **Workspace member** | Bind groups, remove people or change anyone's access, or change how people get in |

A steward suits the team lead who knows who should be in, without handing them
the workspace.

1. Open the workspace and select the **Members** tab. (Or, on **Workspaces**,
   hover over the workspace's card and select **Members**.)
2. Select **Add member**. The **Add member** dialog opens.
3. Choose **User** or **Group**, search, and pick one. A steward adds users
   only, so there's no **Group** choice.
4. Under **Role**, choose a role (see the table below). **Workspace member** is
   selected to start with. The list holds only the roles you may grant.
5. Under **Access duration**, keep **Permanent**, or choose **24h**, **7d**,
   **30d** or **90d** — access then revokes itself, which suits contractors
   and temporary cover.
6. If the workspace's identity provider decides who is in, tick **Add them
   here as an exception** to add a person (see [When the identity provider
   decides](#when-the-identity-provider-decides)).
7. Select **Add to workspace**.

**You should now see** the user or group in the members list with its role. A
binding with a duration shows how long it has left, in an **Expires in …**
badge. Adding someone whose earlier access had ended gives it back to them.

![a workspace's Members tab with the Add member dialog open, showing the User and Group toggle, the Role list and the Access duration choices](/docs-assets/guide/workspace-admin-members.png)

| If they should… | Give them | Because |
| --- | --- | --- |
| Look, not change | **Workspace viewer** | Read-only: they open the workspace's views and see its data sources. |
| Build and edit views, and look after data sources day to day | **Workspace member** | The everyday contributor role. |
| Do what a member does, and let people in | **Workspace steward** | Adds people as viewers or members and answers their requests. |
| Own the data — sources, semantic layers, catalog items and views — without managing people | **Data engineer** | Full data control, but no members or workspace settings. |
| Run the workspace — members, settings, deletion and everything inside | **Workspace admin** | Every permission inside this one workspace, none outside it. |

Custom roles your team has created also appear in the list, when they can be
bound in this workspace and you hold everything they grant.

> **Note:** Binding a group needs the platform's group list
> (`system:groups:manage`) — Org Admins and Super Admins have it. A workspace
> admin without it can still add people one by one, or ask an Org Admin to bind
> the group.

### Seeing who can actually get in

The toggle above the list switches between **Bindings** (what was granted, to
whom) and **People with access** (everyone who can get in, with groups
expanded into their members, and Org Admins and Super Admins, who reach every
workspace). Use **People with access** to answer "can Dana see this workspace?",
and its chips to answer "why?":

| Chip | How they got in |
| --- | --- |
| **Added directly** | Someone added them with **Add member**. |
| **Approved request** | They asked, and an admin or steward approved it. |
| **Exception** | Added here although the identity provider decides who is in — it won't follow their groups. |
| **Identity provider** | A group in your organization's identity provider — it adds and removes them. |
| **Team** | They belong to a team (a group managed in {brand}) bound here. |
| **Organization-wide** | An Org Admin or Super Admin role, which reaches every workspace. |

Hover a chip for who did it and when, the identity-provider groups and
provider, or the team. The counts at the top include **Organization-wide**.

### Removing someone

On their row, select **Revoke binding**. A preview shows what they would
lose; select **Revoke binding** again to confirm. Access ends at their next
request. Only admins remove people.

### Answering access requests

People who can't open a workspace can ask for access — see [Requesting
Access](/guide/requesting-access). Their requests reach the workspace's admins
and stewards in their **Inbox**; when a workspace has neither, they go to the
Org Admins.

1. Select **Workspaces** in the sidebar, then the **Requests** tab — every open
   request across the workspaces you answer, with the count on the tab. (The
   **Members** tab shows its own workspace's requests above the members while
   any are waiting.)
2. Read the request: who asked, for which level, and their reason.
3. Select **Review** and choose your answer — see the table below. Add a note
   if you like; the requester sees it.
4. Select **Approve**, **Add to team**, **Point to group** or **Grant
   exception**.

| The workspace | Your choices |
| --- | --- |
| **Approved in the app** | **Grant a role** — what they asked for or another level you may grant, with **No end date** or for **7**, **30** or **90 days**. **Add to a team** — appears when a team is bound here whose every role you could grant, so they get what their colleagues have. |
| **Through your identity provider** | **Point to a group** — the identity-provider group that grants it. The request waits and closes itself when they next sign in with that group. **Grant an exception** — access here that doesn't follow their groups, for **30 days** unless you choose otherwise. |

To decline, select **Deny**, write a reason (the requester sees it), and select
**Decline**.

**You should now see** the request leave the open list; an approved person can
open the workspace straight away, and **People with access** shows **Approved
request** with your name. **All** lists every request with how it was answered.
The requester follows it on **My access**.

> **Note:** Stewards answer with **Workspace viewer** or **Workspace member**.
> Requests for levels that run the workspace or let others in can't be made;
> grant those with **Add member**. Nobody answers their own request.

### How people get in

The **How people get in** card at the foot of the **Members** tab holds three
settings. Only admins see it.

| Setting | What it does |
| --- | --- |
| **Listed in Find a workspace** | On (the default): everyone who can sign in sees its name, description and who answers requests in **Find a workspace** — once an administrator has switched **Find a workspace** on ([Feature Switches](/guide/feature-switches)). Off: only its members see it there. |
| **Who decides who is in** | **Approved in the app** (the default): admins and stewards answer requests and add people here. **Through your identity provider**: membership follows your identity provider's groups, approvers point people to the group that grants it, and anything granted here is an exception. |
| **A note for people asking** | Shown to people as they ask — "Say which team you're on", for example. Up to 500 characters. |

Select **Save** after changing them.

### When the identity provider decides

Choose **Through your identity provider** when your organization already
manages this workspace's membership with sign-in groups — and someone who runs
sign-in has mapped those groups to roles here (see [SSO
Operations](/guide/sso-operations#workspaces-your-identity-provider-controls)).
Then:

- **Point to a group** answers a request with the group to join. The requester
  is told to ask IT; their access arrives at their next sign-in with the group,
  and the request closes itself. It warns you when they have never signed in
  through the identity provider.
- **Grant an exception** and **Add them here as an exception** let someone in
  without the group — for a contractor, or while IT catches up. Exceptions are
  labelled wherever access is listed, and don't end on their own when the
  person later joins the group; remove them once they have.
- Groups can still be bound with **Add member**.

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

## What's happening in your workspace (the Activity tab)

The **Activity** tab answers "who did this here, when, and why?" for the
workspace's operations, access and data: rebuilds, retries and purges of its
data sources, runs stopped, members added or removed, data sources added or
moved in, and version control turned on.

1. Open the workspace and select the **Activity** tab.
2. Choose a range, and a lens: **Everything**, **Operations**, **Access** or
   **Data**.
3. Narrow it down by person — whether they **Did it**, it was **Done to
   them**, or **Either way** — by action, by outcome, or to the changes that
   came with a reason. To look closer at a stretch of time, drag across
   **What happened, by kind**; **Back** retraces the zoom.
4. Read the band at the top: how busy the workspace has been against the
   period before, which data sources people operate by hand most and how
   often, who is most active, and the reasons people give.
5. Select an event for the full story: who it happened to, the run or data
   source it touched, and the other events from the same request.

**You should now see** the matching events, newest first, grouped by day.

Changes to the views themselves stay in each View's **Activity** (above).
Sign-ins, single sign-on and platform-wide settings never appear here;
auditors see those in **Administration → Activity**. When you rebuild, purge or
stop a run, or add or remove a member, {brand} asks — optionally — why. Your
answer is shown here and in **Administration → Activity**, to auditors and this
workspace's admins.

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
