# Glossary & Acronyms

*For everyone.* Look up any word you meet in {brand} or in this guide: what it
means in one line, and the page that explains it properly.

> **Tip:** New to {brand}? Read [Key Concepts](/guide/key-concepts) first — it
> shows how the most important terms fit together.

Terms are in alphabetical order. Words in **bold** are labels you'll see on
screen.

## A to D

| Term | What it means | Read more |
|---|---|---|
| **Access request** | A request to join a workspace with a chosen role, sent with **Request access**. A workspace admin approves or denies it, and you can follow it under **My access requests**. | [Requesting Access](/guide/requesting-access) |
| **Aggregation** | The background job that builds a data source's lineage summaries (rollups), so lines can be drawn between collapsed items. | [Data Freshness & Ingestion](/guide/data-freshness) |
| **Analytics** | The sidebar page with growth, engagement and adoption figures for the platform. | [Analytics](/guide/analytics) |
| **Announcement** | A banner message an administrator shows to everyone, set under **Administration → Announcements**. | [The Admin Console](/guide/governance-ops) |
| **Approval** | The step where an administrator lets a new account in: **Approve** under **Administration → User Management**. | [Users & Access](/guide/users-access) |
| **Audit Log** | The record of sign-ins, access changes and account changes, under **Administration → Audit Log**. | [The Admin Console](/guide/governance-ops) |
| **Branding** | The app name, logo, theme and support address an administrator sets under **Administration → Branding**. | [The Admin Console](/guide/governance-ops) |
| **Canvas** | The area where a view's graph is drawn and explored. | [Reading Lineage](/guide/reading-lineage) |
| **Catalog item** | A graph found on a provider and registered so it can be added to a workspace as a data source. | [Admin Setup](/guide/admin-setup) |
| **Context View** | A canvas type that sorts entities into columns (layers) you define and draws the lineage between them — made for reading a pipeline. | [The Lineage Lens & Context View](/guide/lineage-lens) |
| **Create View wizard** | The wizard that **New View** opens (titled **Create New View**): **Scope**, **Basics**, **Layout**, **Entities**, **Preview**. | [Creating Views](/guide/creating-views) |
| **Data health** | A tab of a view's versioning panel, shown only to people who manage the data source. It checks the graph against its published versions and can rebuild it. | [Data Freshness & Ingestion](/guide/data-freshness) |
| **Data source** | A graph added to a workspace together with the semantic layer that describes it. Every view is built on one. | [Admin Setup](/guide/admin-setup) |
| **Density** | The Lineage Lens control for how much is folded away: **Overview**, **Grouped** or **Every card**. | [The Lineage Lens & Context View](/guide/lineage-lens) |
| **Display rule** | A rule that tags every entity matching a search with a coloured chip; found under **Properties → Display rules**. | [Display Rules](/guide/display-rules) |
| **Downstream** | What a piece of data feeds — follow the arrows forwards. | [Reading Lineage](/guide/reading-lineage) |
| **Draft** | Your private working copy of a data source's graph. Edits go there; the published version stays untouched until the draft is published. | [Editing in a Draft](/guide/editing-in-a-draft) |
| **Drift** | Something changed after it was last built. **Graph Drift Detected** means the graph changed since its last aggregation. | [Data Freshness & Ingestion](/guide/data-freshness) |

## E to L

| Term | What it means | Read more |
|---|---|---|
| **Edge** | A line between two nodes — a relationship. | [Reading Lineage](/guide/reading-lineage) |
| **Edit mode** | Working in a draft: **Edit** in a Context View starts it. Also the name of the switch that allows editing at all. | [Editing in a Draft](/guide/editing-in-a-draft) |
| **Editor** / **Viewer** (on a view) | The two roles you can give someone on one view in **Share**: editors can edit it, viewers can read it. | [Managing & Sharing Views](/guide/managing-views) |
| **Entity** / **entity type** | An item in the graph — a table, a column, a dashboard. Its entity type says what kind of thing it is. | [Key Concepts](/guide/key-concepts) |
| **Entity drawer** | The panel on the right with an entity's details, opened with **View & Edit** on its right-click menu. | [Tracing Lineage on the Canvas](/guide/exploring-graph) |
| **Explorer** | The catalogue of saved views across all your workspaces. Open it with **Explore** in the sidebar. | [Finding Views](/guide/browsing-views) |
| **Favorites** | Views you've marked with the heart. Find them in the **Favorites** popover in the top bar, or the Explorer's **Favorites** filter. | [Finding Views](/guide/browsing-views) |
| **Feature switch** | An on/off setting under **Administration → Features** that turns a capability on or off for everyone in the deployment (also called a feature flag). | [Feature Switches](/guide/feature-switches) |
| **Freshness** | How current a data source's lineage summaries are. Administrators watch it under **Ingestion → Freshness**. | [Data Freshness & Ingestion](/guide/data-freshness) |
| **Granularity** | How fine the lineage you see is — column, table or whole system. There's no global switch: open or close containers, or use the Lineage Lens **Density** control. | [Reading Lineage](/guide/reading-lineage) |
| **Graph** (canvas type) | A canvas type that shows entities and their relationships positioned freely, for exploring how things connect. | [Creating Views](/guide/creating-views) |
| **Graph store** | The graph database server that holds the graphs. Administrators watch its nodes under **Administration → Graph store**. | [The Graph Store](/guide/graph-store-topology) |
| **Group** | A named set of people given access together, under **Administration → Groups**. Members are added by hand or by a single sign-on access rule. | [Users & Access](/guide/users-access) |
| **Help** | The question-mark button in the top bar (or press **?**): search this guide and the documentation without leaving your work. | [Welcome](/guide/welcome) |
| **Hierarchy** (canvas type) | A canvas type that nests entities inside their parents, as a tree you expand and collapse. | [Creating Views](/guide/creating-views) |
| **Impact** | Everything downstream of an entity — what a change to it could affect. **Impact** in the entity drawer traces it. | [Tracing Lineage on the Canvas](/guide/exploring-graph) |
| **Inbox** | The bell in the top bar. It lists views shared with you, requests to publish a view, and answers to your own publish requests. | [Managing & Sharing Views](/guide/managing-views) |
| **Invite link** | A sign-up link an administrator creates, carrying a role and groups. The **Invite links** switch can stop every link at once. | [Users & Access](/guide/users-access) |
| **Layer** | A column of a Context View, holding the entity types or entities placed in it. | [Navigating Layers](/guide/navigating-layers) |
| **Lineage** | How data flows from where it starts to where it's used. | [Reading Lineage](/guide/reading-lineage) |
| **Lineage Lens** | A focused picture of one entity's connections over the canvas, walked one hop at a time. Open it with **Focus Lens**, or **Focus Connections** on the right-click menu. | [The Lineage Lens & Context View](/guide/lineage-lens) |

## M to R

| Term | What it means | Read more |
|---|---|---|
| **Merge** | Apply a reviewed draft's changes to the published version, from its review. | [The Review Center](/guide/review-center) |
| **Merge request** | A request to merge a draft, opened with **Submit for review**. A reviewer can **Approve**, **Merge** or **Dismiss** it. | [The Review Center](/guide/review-center) |
| **Multi-entity trace** | A trace started from several entities at once: choose **Select**, pick the entities, then **Trace N Entities** (for example **Trace 3 Entities**). | [Tracing Lineage on the Canvas](/guide/exploring-graph) |
| **My access** | Your page — avatar menu → **My access** — listing your roles, what they allow, and your access requests. | [Users & Access](/guide/users-access) |
| **New View** | The Explorer button that opens the Create View wizard. | [Creating Views](/guide/creating-views) |
| **Node** | One item drawn on the canvas — an entity. | [Reading Lineage](/guide/reading-lineage) |
| **Ontology** | Another name for a semantic layer. | [The Semantic Layer](/guide/semantic-layer) |
| **Org Admin** | An organisation-wide role that manages every workspace and creates new ones, but doesn't manage user accounts or sign-in settings. | [Users & Access](/guide/users-access) |
| **Org Auditor** | An organisation-wide role that can see every workspace and the activity log, but can't change anything. | [Users & Access](/guide/users-access) |
| **Orphan** | An entity whose type normally sits inside another (a table in a schema) but which has no parent in the data. List them with **Display → Advanced → Orphaned entities…** in a Context View. | [Navigating Layers](/guide/navigating-layers) |
| **Persona toggle** | The **Business** / **Technical** switch in the top bar. **Business** shows names only; **Technical** adds each entity's qualified name or URN under its name. | [Reading Lineage](/guide/reading-lineage) |
| **Profiling** | A data source's counts and make-up over time, under **Ingestion → Profiling**. | [Data Freshness & Ingestion](/guide/data-freshness) |
| **Projection Mode** | Where a data source's rollups are written when its aggregation runs: **In-Source** (into the source graph) or **Dedicated Graph** (a separate graph, leaving the source untouched). | [Rollup Capacity & Large Graphs](/guide/rollup-capacity) |
| **Provider** | A registered connection to a graph database, added with **Register Provider** under **Ingestion → Providers**. | [Admin Setup](/guide/admin-setup) |
| **Publish** (a draft) | Send a draft's changes to the published version: **Submit for review** opens a merge request; **Publish now** skips review and is only offered to people who manage the data source. | [Editing in a Draft](/guide/editing-in-a-draft) |
| **Publish request** (a view) | Asking for a view to become **Enterprise** when you can't publish it yourself: **Ask to publish this view**, then **Send request**. | [Managing & Sharing Views](/guide/managing-views) |
| **Published** | The live version of a data source's graph that everyone sees. | [Versioning & Change Control](/guide/versioning-change-control) |
| **Pull latest** | Bring changes published since your draft began into the draft — **Pull latest** in a review, **Get latest updates** in the draft. A review can't merge until its draft is up to date. | [The Review Center](/guide/review-center) |
| **Relationship type** | A kind of edge, defined by the semantic layer — some mean "contains", others mean data flows. | [The Semantic Layer](/guide/semantic-layer) |
| **Review & Save** | Where you check every staged edit and save them to your draft together — the **Review & Save Changes** dialog, then **Save N changes**. | [Editing in a Draft](/guide/editing-in-a-draft) |
| **Review Center** | A workspace's **Reviews** tab: the merge requests waiting for review across the workspace. | [The Review Center](/guide/review-center) |
| **Role** | A named set of permissions. Organisation-wide: **User**, **Org Auditor**, **Org Admin**, **Super Admin**. In a workspace: **Workspace Admin**, **Data Engineer**, **Member**, **Viewer**. | [Users & Access](/guide/users-access) |
| **Rollup** | A line between two collapsed items that summarises the lineage between everything inside them. Built by the data source's aggregation. | [Rollup Capacity & Large Graphs](/guide/rollup-capacity) |
| **Root Cause** | Everything upstream of an entity — where its data comes from. **Root Cause** in the entity drawer traces it. | [Tracing Lineage on the Canvas](/guide/exploring-graph) |

## S to Z

| Term | What it means | Read more |
|---|---|---|
| **Scope** | Where a role applies: the whole organisation, or one workspace. | [Users & Access](/guide/users-access) |
| **Search** | The search box in the top bar (⌘K / Ctrl-K) — find pages, views, workspaces and documentation. Inside a view, **Advanced search** (⌘⇧F / Ctrl-Shift-F) finds every match on the canvas. | [Advanced Search](/guide/advanced-search) |
| **Semantic layer** | The definitions of what your data means — its entity types, relationship types and how they nest. Managed under **Semantic Layers**; a published version's definitions never change — editing them creates a new version. | [The Semantic Layer](/guide/semantic-layer) |
| **Stage changes** | The button at the foot of an editing drawer that keeps your edit for **Review & Save** (⌘S / Ctrl-S). Nothing is saved yet. | [Editing in a Draft](/guide/editing-in-a-draft) |
| **Sync chip** | The chip next to the data source's name in a view's header that says whether the view reads the latest data — for example **In sync · v12** or **1 version behind**. | [Data Freshness & Ingestion](/guide/data-freshness) |
| **Telemetry** | Product usage and content gaps, for administrators, under **Administration → Telemetry**. | [The Admin Console](/guide/governance-ops) |
| **Trace** | Following an entity's lineage across the graph: **Trace Lineage** on the canvas, or **Root Cause**, **Impact** or **Full Lineage** in the entity drawer. | [Tracing Lineage on the Canvas](/guide/exploring-graph) |
| **Trace dock** | The panel along the bottom of a Context View while a trace is open, with its **Upstream depth** and **Downstream depth** sliders and **Share**. | [Tracing Lineage on the Canvas](/guide/exploring-graph) |
| **Upstream** | Where a piece of data comes from — follow the arrows backwards. | [Reading Lineage](/guide/reading-lineage) |
| **View** | One saved, curated canvas built on a data source, with its own layout and sharing. Open views from the Explorer. | [Finding Views](/guide/browsing-views) |
| **Visibility** | Who can see a view: **Private** (you, people it's shared with, and workspace admins), **Workspace** (everyone in its workspace) or **Enterprise** (anyone signed in, read-only outside its workspace). | [Who can see a View](/guide/managing-views#who-can-see-a-view) |
| **Workspace** | A space for one team or project, holding its data sources, views and members. Open one from **Workspaces** in the sidebar. | [Key Concepts](/guide/key-concepts) |

## Acronyms

| Acronym | Stands for | In {brand} |
|---|---|---|
| **ADR** | Architecture Decision Record | A recorded design decision, kept in the engineering [documentation](/docs/decisions). |
| **CSV**, **TSV**, **NDJSON**, **JSON** | Comma-separated values, tab-separated values, newline-delimited JSON, JavaScript Object Notation | File formats that **Import…** accepts, along with Excel. See [Import & Export](/guide/import-export). |
| **HTTP** | Hypertext Transfer Protocol | The numbers in messages such as "HTTP 403" are its status codes. See [Troubleshooting](/guide/troubleshooting). |
| **IdP** | Identity provider | The service you sign in with through single sign-on — usually your organisation's directory. |
| **JWT** | JSON Web Token | The signed token that carries your signed-in session. |
| **OIDC** | OpenID Connect | A sign-in standard that a single sign-on connection can use. See [Single Sign-On](/guide/sso-setup). |
| **OOM** | Out of memory | "OOMKilled" means a container was stopped for using more memory than it was allowed. |
| **RBAC** | Role-Based Access Control | Giving people permissions through roles. See [Users & Access](/guide/users-access). |
| **SAML** | Security Assertion Markup Language | Another sign-in standard that a single sign-on connection can use. |
| **SCIM** | System for Cross-domain Identity Management | A standard for syncing users and groups from a directory. {brand} doesn't use it: groups get their members by hand or from single sign-on access rules. |
| **SSO** | Single sign-on | Signing in through your organisation's identity provider. See [Running Single Sign-On](/guide/sso-operations). |
| **UI** | User interface | The screens and controls of {brand}. |
| **URN** | Uniform Resource Name | An entity's unique identifier. **Copy URN** on the right-click menu copies it. |
| **WIP** | Work in progress | A suggested name prefix or tag for unfinished views. See [Ways of Working](/guide/ways-of-working). |

## Product and technology names

| Name | What it is |
|---|---|
| **DataHub** | A metadata platform that you can register as a provider. |
| **FalkorDB** | A graph database. {brand} writes versioned graphs to it, and it is the store shown on **Administration → Graph store**. |
| **Google Spanner Graph** | Google Cloud's graph database, which you can register as a provider. |
| **Neo4j** | A graph database that you can register as a provider. |
| **PostgreSQL** | The database that holds {brand}'s own records — accounts, workspaces, views and the published history of versioned graphs. |
| **Redis** | Holds {brand}'s caches and background-job streams. See **Administration → Redis & Graph Store**. |

## Where to next

- [Key Concepts](/guide/key-concepts) — when you want to see how these terms fit
  together.
- [Troubleshooting](/guide/troubleshooting) — when a message on screen uses a
  word you don't recognise.
- [Quick Start](/guide/quick-start) — when you're ready to try the core terms
  out in your own workspace.
