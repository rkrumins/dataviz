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
> - The **People** tab appears to the people who let others into that
>   workspace (`workspace:members:add`) — its **Workspace admins** and
>   **Workspace stewards**, **Org Admins** and **Super Admins**. Removing
>   people and choosing how people get in stay with admins (`workspace:admin`).
> - Adding, editing and re-aggregating data sources needs
>   `workspace:datasource:manage` — **Workspace admin**, **Data engineer** and
>   **Workspace member** all hold it.
> - Moving a data source that has views to another workspace needs **Workspace
>   admin** in both workspaces; an admin of only one can ask the other to take it.

---

## Find your way around a workspace

Open **Workspaces** in the sidebar and select a workspace. It opens on its
**Overview**, which is built for using the workspace rather than configuring it.

The header shows:

- the workspace's name and description;
- its health as a sentence, such as *"Risk Models" couldn't finish refreshing*,
  with a link to where it's fixed if you can fix it;
- how many people use it, and what they open most;
- your own role in it.

**Explore views** opens everything built here in the Explorer. **New view**
starts a view in this workspace, if you can create one. Under **⋯** are the data
model editor and ingestion jobs, for the people who use them.

The **Overview** shows:

- **Needs your attention** — reviews asking for you, people asking to join,
  sources that need a look, data sources waiting to move and drafts whose owner
  left. Each row has the one place to go about it, and appears only if it is
  yours to act on.
- **Get this workspace ready** — for admins and the people who manage its data,
  while the workspace is new. It ticks off connecting data, choosing a data
  model, building its connections, creating the first view and inviting people.
- **Jump back in** and **Popular here** — the views you opened or favourited
  here, and what everyone here opens most.
- **At a glance** and **Recent changes**.

The rest lives on tabs. You see only the tabs you can use:

| Tab | Use it to | Who sees it |
| --- | --- | --- |
| **Overview** | See what needs you, get back to your views, and take in the workspace at a glance | Everyone who can open the workspace |
| **Views** | Oversee every view: visibility, owners, bulk changes and publication requests | Everyone who can open the workspace |
| **Data** | **Sources** — the graphs that feed this workspace. **Data model** — what changed in their ontologies. **Processing** — how fresh each source's connections are, and rebuilding them. **Trends** — how counts are changing | Everyone who can open the workspace. Adding sources and rebuilding need data-source permission; **Trends** needs a built-in workspace role |
| **Reviews** | Review merge requests across the workspace's versioned sources | Only while **Version control** is on — it is by default |
| **People** | Decide who can get in, with which role, and answer their requests | Workspace admins and stewards, Org Admins and Super Admins |
| **Activity** | See who ran, changed or granted what in this workspace — when, and why | Workspace admins, Org Admins, Org Auditors and Super Admins |
| **Settings** | Set how entities are recognised, and how drafts and reviews work | Workspace admins and anyone who manages its data sources |

> **Business or Technical:** the page follows the **Business / Technical** switch
> at the top of the app. In **Technical** it also shows identifiers, node and edge
> counts, database vendors, projection modes and raw error messages.

> **Older links still work:** a link to a former tab, such as `?tab=aggregation`
> or `?tab=members`, opens the matching place: **Data → Processing**, or **People**.

> **If you don't see Reviews:** **Version control** is switched off in
> **Administration → Features** — see [Feature
> Switches](/guide/feature-switches). **If you don't see People:** you aren't
> an admin or steward of this workspace.

---

## Giving people access (the People tab)

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
| **Workspace steward** | Add people as **Workspace viewer** or **Workspace member**, and answer requests at those levels — otherwise a **Workspace member** | Bind groups, remove people or change anyone's access, let someone in as an exception, or change how people get in |

A steward suits the team lead who knows who should be in, without handing them
the workspace.

1. Open the workspace and select the **People** tab. (Or, on **Workspaces**,
   hover over the workspace's card and select **Members**.)
2. Select **Add member**. The **Add member** dialog opens.
3. Choose **User**, **Group** or **Service account**, search, and pick one; a
   service account says what it is for and who manages it. A steward adds
   users and service accounts only, so there's no **Group** choice.
4. Under **Role**, choose a role (see the table below). **Workspace member** is
   selected to start with. The list holds only the roles you may grant.
5. Under **Access duration**, keep **Permanent**, or choose **24h**, **7d**,
   **30d** or **90d** — access then revokes itself, which suits contractors
   and temporary cover.
6. If the workspace's identity provider decides who is in, tick **Add them
   here as an exception** to add a person — admins only, and an exception
   always ends, so **Permanent** isn't offered (see [When the identity
   provider decides](#when-the-identity-provider-decides)).
7. Select **Add to workspace**.

The dialog lists the workspace's data sources, restricted ones first: any
role here reads all of them — there are no per-source grants inside a
workspace — so check the list before letting someone into a workspace that
holds a sensitive one.

**You should now see** the user or group in the members list with its role. A
binding with a duration shows how long it has left, in an **Expires in …**
badge. Adding someone whose earlier access had ended gives it back to them.

The person hears in their **Inbox** when you add them, remove them or change
when their access ends; a team's members aren't told when the team is bound.
Someone with time-limited access is reminded before it ends — a week ahead for
access granted for more than two weeks, two days ahead for shorter access — and
can ask to keep it ([Requesting Access](/guide/requesting-access#keep-access-thats-about-to-end)).

To change when a binding ends, select **Change** beside its **Expires in …**
badge and choose **End in 7 days**, **End in 30 days**, **End in 90 days** or
**No end date** — counted from today. Only admins change it; a request the
person made to keep the access reads as answered. An exception keeps an end
— **No end date** isn't offered — and the menu says it **Stays an
exception**.

![a workspace's Members tab with the Add member dialog open, showing the User and Group toggle, the Role list and the Access duration choices](/docs-assets/guide/workspace-admin-members.png)

| If they should… | Give them | Because |
| --- | --- | --- |
| Look, not change | **Workspace viewer** | Read-only: they open the workspace's views and see its data sources. |
| Build and edit views, and look after data sources day to day | **Workspace member** | The everyday contributor role. Changes versioned data in drafts, and can't publish them. |
| Do what a member does, and publish versioned data sources' drafts | **Publisher** | Publishes drafts, merges reviews, syncs. Give it to the service accounts whose automation should publish too. |
| Do what a member does, and let people in | **Workspace steward** | Adds people as viewers or members and answers their requests. |
| Own the data — sources, semantic layers, catalog items and views — without managing people | **Data engineer** | Full data control, publishing included, but no members or workspace settings. |
| Run the workspace — members, settings, deletion and everything inside | **Workspace admin** | Every permission inside this one workspace, none outside it. |

Custom roles your team has created also appear in the list, when they can be
bound in this workspace and you hold everything they grant.

> **Note:** Binding a group needs only this workspace's admin role, not the
> platform's group list: **Group** searches every group, and a bound group's
> row opens to show the people it lets in here. Creating platform-wide groups
> and changing who is in them stays with `system:groups:manage` — Org Admins
> and Super Admins have it. The workspace's own groups are its admins' to
> manage (see [Your workspace's groups](#your-workspaces-groups)).

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
| **Joined** | They joined themselves, as a Viewer, while the workspace was open to everyone. |
| **Identity provider** | A group in your organization's identity provider — it adds and removes them. |
| **Team** | They belong to a team (a group managed in {brand}) bound here. |
| **Organization-wide** | An Org Admin or Super Admin role, which reaches every workspace. |

Hover a chip for who did it and when, the identity-provider groups and
provider, or the team. The counts at the top include **Organization-wide**.

A row marked **Service account** is an account an integration acts as,
through API keys its managers make; nobody signs in as it. You let one in as
you would a person — with **Add member**, or by approving a request its
managers make for it — and remove it here: its managers hear about it. Its
name opens its page, which says what it is for and who manages it. See
[Service Accounts](/guide/service-accounts#for-workspaces).

### Removing someone

On their row, select **Revoke binding**. A preview shows what they would
lose; select **Revoke binding** again to confirm. Access ends at their next
request. Only admins remove people.

Whoever manages a [service account](/guide/service-accounts) can do
whatever it can. So if they manage one — themselves or through a team —
whose role here gives more than they would keep, the preview names it:
through its keys they could still act here. Tick **Remove its role here
too** to remove that as well, or ask its other managers to remove them as a
manager.

### Your workspace's groups

A workspace can have groups of its own — the ones an approved [workspace
request](/guide/requesting-a-workspace) made, and any its admins make. They're
listed under **Groups** on the People tab. Each card says what the group can do
here, who is in it, and whether it follows a group in your identity provider.

The workspace's admins manage these groups there, without the platform's group
list:

1. Click **New group**, or one of the starters (**Editors**, **Viewers**,
   **Publishers**) when there are none yet.
2. Give it a name, choose what its people can do here (**Can view**, **Can
   edit** or **Can publish**), and invite people. Its name always starts with
   the workspace's — "Lab · Engineers" — because group names are unique across
   {brand}.
3. Optionally, name the identity-provider group it should follow.

Click a group's card to rename it, change its role, add or remove people, link
it to the identity provider, or delete it. Stewards see the groups and who is in
them; only admins change them.

Groups bound here that the workspace doesn't own are listed too, marked
**Platform group**, and managed on the platform's Groups page. So is a group of
yours that has also been given access somewhere you can't grant, or that manages
a service account: who is in it decides more than this workspace.

A group can be **linked to a group in your identity provider** (an Active
Directory group, say), so its members follow the directory at each sign-in. As
you type, the identity-provider groups you yourself had at your last sign-in are
suggested — nobody sees anyone else's. Linking is a Super Admin's call: when you
click **Ask to link**, the group's card shows the link waiting, Super Admins
find it under **Workspaces → Requests** (with how many people have that group,
and the connection to link it from), and you hear in your Inbox whether it was
linked or declined. People the identity provider put in a group are marked
**From the directory**; they leave it there, not here.

### Answering access requests

People who can't open a workspace can ask for access — see [Requesting
Access](/guide/requesting-access). Their requests reach the workspace's admins
and stewards in their **Inbox**; when a workspace has neither, they go to the
Org Admins.

1. Select **Workspaces** in the sidebar, then the **Requests** tab — every open
   request across the workspaces you answer, with the count on the tab. (The
   **People** tab shows its own workspace's requests above the members while
   any are waiting.)
2. Read the request: who asked, for which level, and their reason.
3. Select **Review** and choose your answer — see the table below. Add a note
   if you like; the requester sees it.
4. Select **Approve**, **Add to team**, **Point to group** or **Grant
   exception**.

A request that has waited a day or more shows **Waiting N days**. After three
days without an answer, {brand} reminds the workspace's admins and stewards;
after a week it tells the Org Admins, and the request shows **Sent to the Org
Admins**. Requests waiting on the identity provider aren't brought up — IT has
them.

A request **to keep access** ("asks to keep **Member** — ends …") comes from
someone whose time-limited access is ending. **Review** asks only how much
longer — **30 days** unless you choose **7 days**, **90 days** or **No end
date** — and **Let them keep it** extends the same grant.

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
> grant those with **Add member**. Nobody answers their own request, nor one
> for a service account they manage or asked for.

### How people get in

The **How people get in** card at the foot of the **People** tab holds four
settings. Only admins see it.

| Setting | What it does |
| --- | --- |
| **Listed in Find a workspace** | On (the default): everyone who can sign in sees its name, description and who answers requests in **Find a workspace** — once an administrator has switched **Find a workspace** on ([Feature Switches](/guide/feature-switches)). Off: only its members see it there. |
| **Who decides who is in** | **Approved in the app** (the default): admins and stewards answer requests and add people here. **Through your identity provider**: membership follows your identity provider's groups, approvers point people to the group that grants it, and anything granted here is an exception. |
| **How people ask** | **Approvers decide** (the default): people ask, and admins and stewards answer. **Open to everyone**: anyone can join as a **Workspace viewer** at once, without approval — more is still asked for; not available while the identity provider decides who is in. A Viewer reads every data source here, restricted ones included, and a workspace hidden from Find a workspace can still be joined by anyone with a link — the card says so when either applies. **Closed to requests**: nobody can ask to join, and admins add people with **Add member**; people already in can still ask to keep access that's ending. |
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
  without the group — for a contractor, or while IT catches up. Only admins
  grant them — a steward points people to the group — and they always end,
  within 90 days. Keeping one going, from a request to keep it or with
  **Change**, keeps it an exception, with a new end within 90 days. Exceptions are
  labelled wherever access is listed, and end on their own once the person's
  identity provider groups grant the same access: at their next sign-in, an
  exception for the role a group grants becomes that group's grant — no gap —
  and one the groups' roles cover is ended. The person and whoever granted it
  hear about it.
- Groups can still be bound with **Add member**.
- A [service account](/guide/service-accounts)'s role is not an exception: the
  identity provider doesn't know the account, so only admins give it a role
  here, and it lasts until it is taken away, or until the end they chose. A
  request for one is approved or declined, never pointed to a group.

### Reviewing who has access

An **access review** goes through the grants made here — people's and teams' —
so you can keep or remove each. The **Access reviews** card sits at the foot of
the **People** tab; only admins see it.

1. Under **Access reviews**, choose when it's due — **7**, **14** or **30
   days** — and select **Start a review**. It takes a snapshot of the grants as
   they stand. People who get in through the identity provider or an
   organization-wide role are counted, not reviewed — removing them here
   wouldn't hold.
2. For each grant, select **Keep** or **Remove**. The row shows the role, how
   it came about, when it was granted and ends, and when the person last
   signed in. **Remove** asks you to confirm, then takes the access away at
   once; the person hears why. A kept grant can still be removed while the
   review is open. A **Service account** never signs in — an integration acts
   as it — and its managers are the ones who hear why.
3. When every grant is decided, select **Complete review**.

**You should now see** the review under the earlier ones, with how many grants
were kept and removed. **Download CSV** saves the review for your records;
**Cancel review** stops it, and what was already removed stays removed.

> **Note:** Nothing is removed unless you remove it. A review past its due
> date is only flagged — its admins and whoever started it hear once.

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

### Workspaces people ask for

People who can't create workspaces may ask for one (while **Workspace requests** is on
in [Feature Switches](/guide/feature-switches)). As someone who creates workspaces, you
answer them on **Workspaces → Requests**, under **Requests for new workspaces**:
approve one (tidying its name first if you like), send it back with a question, or
decline it. Approving creates the workspace with the requester as its admin, adds the
teammates they named and moves the Playground graphs they chose. See
[Requesting a Workspace](/guide/requesting-a-workspace#for-platform-and-org-admins-answer-requests).

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
it from **Data → Processing** when you're ready (see below).

> **Note:** Aggregation needs a semantic layer. A source left on **System
> defaults** isn't aggregated until you assign a layer: select the source on
> **Data → Sources**, select **Edit**, choose a **Semantic layer (ontology)**, then
> **Save changes**.

### Describe it, and name who vouches for it

With **Data source details** on, a source's Overview opens with **About this data**:
anyone who manages its sources can **Edit details** — a description, links and tags.
Then name its **Owner** and **Stewards** under **Who to ask about this data**: they,
and the workspace's admins, can **Change status** to certify it (or mark it in review
or deprecated) and label how sensitive it is. A named Owner or Steward can also mark a
data request connected to their source. See [Describing and Trusting
Data](/guide/describing-data).

---

## Moving a data source between workspaces

Teams reorganize, and data sources sometimes need to move with them. A data source
moves to another workspace **with everything built on it**: its views (including any
in the trash), their history, its version history, forks included, with open drafts and
review requests, and its aggregation state and stats. The new workspace gets a fully working source, not a
blank slate, and nothing is rebuilt.

How you move it depends on what you run:

| You administer | What happens |
| --- | --- |
| Both workspaces | You move it straight away. |
| Only the one it's in | You send a **transfer request**, and the other workspace's admins accept or decline it. |

> **Note:** Once views are built on a source, moving it changes who can read other
> people's work, so it takes **Workspace admin** in both workspaces. A source with
> nothing built on it can still be moved by anyone who manages data sources in both
> (**Workspace member** and up).

### Move it

1. On **Data → Sources**, select the source to open it, open its **⋯** menu and
   choose **Move to another workspace…**.
2. **Destination** — pick where it goes. Each workspace says what you can do there:
   move it now, or ask its admins. Workspaces it can't go to are folded under ***N*
   workspaces can't take it**, each with the reason, such as **Already has this graph**.
3. **What moves** — check how many views move (and how many are in the trash or
   follow the workspace's default source), its version history, and what you should
   know — such as a restricted source going to a workspace that's open to everyone,
   where anyone who joins can read it. The forks of its version history, and open
   drafts and review requests on it and on its forks, go with it; a draft whose owner
   can't open the new workspace is named, so you can add them there. Anything under
   **Resolve before moving** has to be dealt with first: an aggregation run, or a
   version-history job in progress on it or on a fork of it, has to finish, and a
   failed attempt to turn on version control has to be resumed or cancelled. A source
   with more than 50,000 views can't be moved in one go.
4. **Access** — see who **keeps access**, who **gains access** and who **loses
   access**. After the move, the new workspace's own members, groups and
   identity-provider mappings decide who reads the views. Owners and anyone a view is
   shared with keep it, and views published to everyone stay published. The people
   and groups who read the views only because they're in the old workspace lose
   them; each says where their access came from — the app, a group, or your
   identity provider (**Identity provider**).
5. **Confirm** — read the summary, say why you're moving it and, if anyone loses
   access, tick **I understand … lose access**. Then select **Move to *workspace***
   (or **Send request**).

**You should now see** "*Source* now lives in *workspace*", with **Open in
*workspace*** and **Undo**.

Everyone who lost access gets an Inbox notice saying where the views went and how to
get back in, the way the new workspace takes people: **Ask to join** where approvers
decide, **Join** where it's open to everyone, or asking its admins where it's closed to
requests. Both workspaces' admins are told who lost access, and the source's panel
says how many. To give someone access again, add them or their group to the new
workspace — or, where your identity provider decides, map their identity-provider
group to it, so the provider keeps deciding.

[screenshot-pending]: # "workspace-admin-move-access — the Access step of moving a data source, listing who loses access"

### Answer a transfer request

When another workspace asks to move a source into yours, its admins hear about it in
their Inbox, and the request appears on **Workspaces → Requests** and as a banner on
the workspace's **Data → Sources**.

1. Select **Review**. You see exactly what would move, who would lose access, and
   anything that has changed since they asked.
2. Select **Accept and move**, or **Decline** with a reason they'll see.

Requests expire after 14 days. The person who asked can cancel theirs from the
source's panel.

[screenshot-pending]: # "workspace-admin-review-transfer — reviewing a transfer request, with what changed since it was sent"

### Undo a move

For 7 days after a move, the source's panel says where it came from and offers
**Undo**. Undo puts everything back as it was: the workspace, the primary source and
the views, so the old workspace's members read them again — and the people who lost
access are told it's back. It isn't offered once a view has been built on
the source in its new workspace, or once the source has moved again — move it back
instead. A move made by accepting a request can only be undone by the destination's
admins.

Every move, request, undo and request that expired unanswered appears in both
workspaces' **Activity** and in each moved view's own activity, and **Where it has
lived** on the source's panel lists each move.

[screenshot-pending]: # "workspace-admin-moved-from — a moved source's panel, showing where it came from, with Undo"

### Start from the destination

If you administer both workspaces, you can also start from the destination: on its
**Data → Sources**, select **Add source** and pick a source that belongs to another
workspace. A source with views is marked **Move with *N* views** and opens the same
steps, with the destination already chosen.

> **What stays behind:** layout templates shared only in the old workspace (views that
> use them keep working), and file uploads that were in progress — choose the file
> again. API keys limited to the old workspace no longer reach the moved views.

---

## Keeping connections up to date (Data → Processing)

**Aggregation** works out each source's connections — its rolled-up lineage —
ahead of time, so deep lineage opens fast. Views keep working while it runs.
**Data → Processing** shows how fresh every source's connections are and lets you
rebuild them. Status updates live while a job is running.

1. Open the workspace and select **Data**, then **Processing**. The summary at the
   top says how many sources are up to date. Each source shows its status:
   **Up to date**, **Refreshing**, **Queued**, **Didn't finish**, **Skipped** or
   **Not built yet**.
2. To narrow the list, select a status chip such as **1 Didn't finish**; select
   **All** to clear it.
3. To rebuild one source, select **Rebuild** on its card. (While a job is running
   or queued, the button reads **Refreshing…**.) **Rebuild** needs data-source
   permission; everyone else sees the status and history only.
4. To see past runs, select **History** on the card.

**You should now see** the source move to **Queued**, then **Refreshing**, then
**Up to date**.

What the warnings on a card mean:

| Warning | What to do |
| --- | --- |
| **The data changed since these connections were built** | Select **Rebuild** to bring them up to date. |
| **Built the old way** — things that contain things of their own kind won't nest fully | Rebuild it — or select **Rebuild all** at the top, which also shows how many sources **need it**. |
| **Connections not up to date** | Rebuilding won't fix this one — as the card says, check the source's version history. **Administration → Infrastructure** lists any **Graphs not publishing**. |
| **The last refresh didn't finish** | Open **Technical details** to see the error, fix the cause it names, then **Rebuild**. |

**Clear connections** (in the **Technical** view, on an **Up to date** source)
removes that source's aggregated edges after you confirm. You need it before
switching a source to a different aggregation strategy — which you do on the
source's own **Processing** tab (open it on **Data → Sources**): clear, switch,
then rebuild. For platform administrators, **Infrastructure — workers and pipeline defaults** opens the **Workers** panel, which shows the
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

## Watching what changed (Data → Trends)

**Profiling** answers "what moved, and by how much?" across the workspace's
sources, from counts {brand} collects in the background.

1. Open the workspace and select **Data**, then **Trends**.
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
data sources, runs stopped, members added or removed, data sources added, moved
in or out (and requests to move them), and version control turned on.

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
**Data → Data model** shows a timeline of changes to the layers its sources use.

---

## Where to next

- [Users & Access](/guide/users-access) — when you want to choose the right
  roles, use groups, or invite people.
- [Data Freshness & Ingestion](/guide/data-freshness) — when aggregation fails
  or data looks out of date.
- [Describing and Trusting Data](/guide/describing-data) — when you want each
  source to say what it is and whether to rely on it.
- [The Semantic Layer](/guide/semantic-layer) — when you want to understand or
  improve a layer.
- [The Admin Console](/guide/governance-ops) — when you want to keep the whole
  platform healthy.
