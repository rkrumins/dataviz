# View portability: moving views between environments, and their versions

A view's design (its layers, where each entity sits, its rules, display rules and settings) can
leave the environment it was built in and arrive in another where the same data source is
onboarded. Dev, UAT and production each hold their own copy of the graph, so the view is checked
against the graph it arrives in, and anything that doesn't match there is shown rather than
silently lost.

Four pieces make that work:

- **View files** (`*.view.json`, the View Bundle format): one or more views, each with a content
  hash that proves the design is exactly what was exported.
- **View versions**: numbered, immutable checkpoints of a view's design, with history, compare
  and restore. Every export is a real version, and every import records one.
- **The Import journey** in the View wizard: choose the file, see where it belongs, see what
  matched, adjust anything, and create or update a view.
- **View packages** (`*.view-package.zip`): a view together with its graph data. The data goes into
  a draft, and the view follows it there, so the two go live together.

This page is the reference: formats, rules and API. The user guides are
[Managing Views](/guide/managing-views) and
[Import & Export](/guide/import-export#moving-views-between-environments).

---

## Words used here

| Word | Meaning |
|---|---|
| **Definition** | The view's design: `views.config` minus environment keys and label keys (below). It is hashed. |
| **Metadata** | The view's label: name, description, icon, tags and view type. It travels beside the definition and is never hashed, so a renamed copy still proves it holds the same view. |
| **`definitionHash`** | `sha256:` + SHA-256 of the canonical JSON of the definition. Computed only on the server. |
| **`portableId`** | The identity that crosses environments (`pv_…`). Environment ids (view, workspace, data source, user) never travel. |
| **Version** | An immutable checkpoint of a view's definition and metadata, numbered v1, v2, … per view. |
| **Working copy** | The view as it is now. It is *dirty* when it differs from its newest version. |

View versions are the history of a view's **design**. They are not graph version control (drafts,
commits, publish), which versions the graph **data**. The UI keeps the two apart in its wording:
versions are "v8", never commits, and restoring one never touches the graph.

---

## The definition, and its hash

`backend/app/services/view_transfer/canonical.py` is the only place a definition is built and
hashed.

1. Start from `views.config`, and remove:
   - **environment keys**: `id`, `workspaceId`, `dataSourceId`, `scopeKey`, `workspaceName`,
     `isFavourited`, `isDefault`, `visibility`, `isPublic`, `createdBy`, `createdAt`,
     `updatedAt`, `contextModelId`;
   - **label keys**: `name`, `description`, `icon`, `tags`.
2. Normalise the reference layout with `parse_reference_layout`:
   - a legacy top-level `referenceLayout` moves under `layout`;
   - legacy `entityAssignments` and exact-URN rules fold into the flat `assignments` map;
   - side fields (`displayRules`, `defaultNodeSortMode`, and anything newer) are kept as they are;
   - `urn:staged:*` keys (entities that were never saved) are dropped;
   - a `null` inside an assignment entry is dropped, since it means the same as the key being absent.
3. Fill in the implicit: `content.entityScope` is made explicit, and `layout.type` is set.
4. Keep every other key verbatim, including keys this code has never heard of.
5. Serialise canonically: sorted keys, compact separators, UTF-8, no NaN. Hash with SHA-256.

Canonicalising a canonical definition returns it unchanged, so export → import → export → import
yields byte-identical definitions and equal hashes. `tests/test_view_transfer_import.py` proves
it with a view carrying layers, logical nodes, ordered assignments, display rules, entity
overrides, legacy assignments and an unknown future key.

**What never travels:** grants, favourites, visibility, user ids and emails, credentials, and draft
overlays. `exportedBy` carries a display name only.

---

## View files: the View Bundle, version 1

One structure holds 1 to N views, so a single-view export is a bundle with one entry, and there is
one schema, one parser and one importer.

```jsonc
{
  "format": "view-bundle",
  "formatVersion": 1,
  "exportedAt": "2026-09-23T10:00:00+00:00",
  "exportedBy": { "displayName": "Dana Smith" },
  "generator": { "product": "…", "environment": "dev" },
  "sources": {
    "s1": {
      "workspace":  { "id": "…", "name": "Finance" },
      "dataSource": { "id": "…", "label": "Lineage", "providerType": "falkordb", "graphName": "lineage",
                      "catalogSourceIdentifier": "…", "identityProperty": "urn" },
      "ontology":   { "name": "…", "version": 3, "digest": "…" }
    }
  },
  "views": [{
    "source": "s1",
    "portableId": "pv_…",
    "sourceViewId": "view_…",
    "version": 7,
    "definitionHash": "sha256:…",
    "metadata": { "name": "Finance lineage", "description": "…", "icon": "Layout", "tags": ["finance"],
                  "viewType": "reference" },
    "definition": { "layout": { … }, "content": { … }, "filters": { … }, … },
    "manifest": {
      "counts": { "layers": 5, "assignments": 1200, "anchors": 3, "rules": 9, "displayRules": 4,
                  "entityTypes": 6, "relationshipTypes": 2 },
      "entities": { "urn:…": { "name": "revenue", "type": "Table", "qualifiedName": "…" } },
      "entitiesResolved": true
    },
    "history": [{ "environment": "dev", "viewId": "view_…", "version": 7, "hash": "sha256:…",
                  "source": "wizard", "createdAt": "…", "createdBy": "Dana Smith", "message": "…" }],
    "historyTruncated": false
  }],
  "bundleHash": "sha256:…"
}
```

- **`sources`** describe where the views came from, so the target can suggest where they belong.
  Their ids are never used as ids.
- **`manifest.entities`** names every entity the view places, so the target can show *what* didn't
  match rather than a bare URN. `entitiesResolved` is false when the source graph couldn't be asked
  for names at export time.
- **`history`** is the full ancestry: the view's own versions, preceded by history carried in from
  earlier imports, capped at 500 entries (`historyTruncated`). Its hashes let an import into a
  view that already exists find the version they last had in common.
- **`bundleHash`** is taken over the ordered `(portableId, definitionHash)` pairs, so a view added
  to or removed from the file by hand is noticed.

**Integrity.** Each view is `verified` when its definition hashes to its `definitionHash`, and
`modified` when it doesn't (it was edited by hand; it imports as it is now). A file without hashes
is `unverifiable`.

**Format versions.** A file with a newer `formatVersion` is refused with a clear message. Keys the
importer doesn't know are ignored, so a newer exporter's additions don't break an older importer.

**JSON Schema.** `docs/features/view-bundle.v1.schema.json` is rendered from the model the
importer parses with (`backend/common/models/view_transfer.py`):

```bash
python -m backend.scripts.export_view_bundle_schema          # rewrite it
python -m backend.scripts.export_view_bundle_schema --check  # fail if it is out of date
```

`tests/test_view_bundle_schema.py` fails when the committed schema differs from the model, or when
an export writes a key the schema doesn't describe.

---

## Where a view points at the graph

`backend/app/services/view_transfer/references.py` is the only code that knows where a definition
refers to the graph. It collects references for checking, and rewrites them for the importer's
choices (remap an entity, drop it, map a type).

| Kind | Where |
|---|---|
| URNs | assignment keys; `layers[].anchorUrn`; exact-URN `urnPattern` rules on layers and logical nodes; `content.rootUrns`; display-rule predicates (`descendantOf.urns`, `withinHops.urns`, `path.source_urns` / `target_urns`) |
| Entity types | `layers[].entityTypes`; `rules[].entityTypes`; `content.visibleEntityTypes` and `rootEntityTypes`; `filters.entityTypeFilters`; `lod.levels[].visibleEntityTypes`; `projection.targetGranularityType` and `containerTypes`; `entityOverrides` keys; entity-type predicates |
| Relationship types | `content.visibleRelationshipTypes`; `layers[].scopeEdges.edgeTypes` and `excludeEdgeTypes`; `projection.containmentEdgeTypes` |
| Glob URN patterns | Listed, not checked exactly |

---

## Importing

### 1. Inspect

`POST /api/v1/views/transfer/inspect` takes the raw file and writes nothing. It returns the
bundle, each view's integrity, and:

- **identity matches**: views here that already *are* one of the file's views (same
  `portableId`), limited to views the caller can read, each with whether they can edit it and how
  the two stand (below);
- **target suggestions** per source in the file: the data sources here the caller can read, ranked
  by what the file says about its source (provider, graph name or catalog identifier, ontology),
  then measured: a sample of 50 of the view's own entities is looked up in the top candidates
  ("49 of 50 found here").

### 2. Reconcile

`POST /api/v1/views/transfer/reconcile` checks views against a target and writes nothing. Each
URN the view references is looked up (one pass per target graph, whatever the number of views):

| Status | Meaning |
|---|---|
| `matched` | Found, same type. |
| `renamed` | Found, with a different name. Informational. |
| `type_changed` | Found, as a different type. |
| `missing` | Not in this graph. Kept by default, marked "not found"; it goes live if the entity appears later, and it survives the next export. |
| `unknown` | The lookup failed (the graph didn't answer). **Never counted as missing**; retry to check. |

Every referenced entity and relationship type is marked present or missing, with suggestions (a
case-insensitive match first, then the closest names).

The **match rate** is matched ÷ checked. The **verdict** is:

- `ready`: at least 95% matched, no missing types and nothing unchecked;
- `attention`: anything short of that;
- `blocked`: the view's type isn't enabled here, or none of at least 20 checked entities exist
  ("It looks like a different graph").

The importer's **resolutions** (`remap`, `drop`, `typeMap`, `dropTypes`, `relTypeMap`,
`dropRelTypes`) are applied *before* reconciling, so the report always describes the definition
that would be written.

### 3. Import

`POST /api/v1/views/transfer/import` writes one view per call, in one transaction: the view, its
`import` version (with where it came from and how well it matched) and an activity entry. It
re-reads what it stored and hashes it again, and reports `integrity.verified`, or `adjusted` with
the reasons (for example, custom node ordering removed because node sorting is off here).

| Action | What happens |
|---|---|
| `create` | A new view, adopting the file's `portableId`; if that identity is already used in the workspace, it becomes a separate copy and the result says why. |
| `copy` | A new view with a new identity; `forkedFrom` records the file's. |
| `update` | A new version of the view here that already is this view. |
| `overwrite` | Any view the caller can edit takes the file's design; it then tracks the file's identity. Its current design is saved as a version first. |

For `update` and `overwrite`, how the view here and the file stand:

| Status | Meaning |
|---|---|
| `up_to_date` | The view here already has exactly this design. |
| `fast_forward` | The view here hasn't changed since the version they share: taking the file loses nothing. |
| `diverged` | Both changed since the version they share. |
| `file_is_older` | The view here has moved past the file's design. |
| `unrelated` | No version in common. |

The strategy is **Replace** (the file's design as it is) or **Merge** (a three-way merge from the
shared version: layout, display rules, default sort and scope with the existing layout merge, and
every other key per key; the file wins conflicts, which are listed). Merge needs a shared version.

The import also:

- applies the same gates as creating a view (`authorize_view_create`: the RBAC flag and
  `workspace:view:create`, the enterprise publish policy, restricted data sources), and checks the
  data source belongs to the workspace and the view type is allowed here;
- refuses with 409 when an update's target changed since it was reviewed (`expectedTargetHash`);
- returns the first result again for a repeated `requestId`, integrity report included, so
  retries are safe;
- ties a multi-view import together with `batchId`, in each version's provenance and the activity log.

### Several views in one file

The wizard's batch flow maps each source in the file to a data source here, reconciles every view
in one request, and reviews them as a table (action, name, visibility, draft). It then imports one
view per request under one `batchId`; a failure doesn't stop the rest, and "Retry failed" reuses
each view's `requestId`. A view that changed here during the import (`409 target_changed`) goes
back to be checked again first, since retrying against the old check would only be refused again.

---

## Staging an import in a draft

On a data source under version control, an import can wait in a draft of it and go live when the
draft does: when the draft is published, or its review request merges. The wizard offers this by
default where the person may open drafts (`workspace:datasource:manage`).

- **A new view** gets a draft of its own (`views.draft_branch_id`). Until the draft goes live the
  view is private, and it is in no list, count or facet: every live-view query goes through
  `view_is_live()`, and `tests/test_view_live_filter.py` fails if a new query of the views table
  doesn't. Its creator and the draft's readers can open it on the draft. It goes live as private
  or shared with its workspace; publishing to everyone waits until it is live.
- **An update** goes into the importer's draft for that view, as an overlay beside the view's
  layout overlay (`view_layout_overlays.definition`, `label`, fork bases, `staged_provenance`).
  The draft shows exactly what will go live; the view everyone else sees is unchanged.
- **Publishing or merging** the draft promotes its views: a new view goes live with its staged
  visibility, and an update merges three ways from where the draft forked (the file wins), then
  records a version. **Abandoning** the draft discards them.
- A draft that changes only views can be published, and publishing it settles its open review
  request. The draft's Changes tab, the review request and the publish dialog list its views
  (`GET …/branches/{branch_id}/view-changes`).
- The worker's sweep settles staged views whose draft ended without reaching them, and discards
  those of abandoned or swept drafts.

---

## A view with its data: the View Package, version 1

```
finance-lineage.v7.view-package.zip
  package.json        format, formatVersion, createdAt, scope, data {version, nodes, edges},
                      and per part: sha256, bytes (and for the bundle: views, bundleHash)
  view-bundle.json    the views, exactly as a view file
  data/graph.ndjson   the data source's own lossless export (importable on its own, too)
```

**Export** (`POST /api/v1/views/transfer/packages`): views from **one** data source under version
control. The scope is `view` (the one view's entities; exactly one view) or `source` (the whole
data source; any number of its views). The data version is `published`, or `draft` (the caller's
own draft of the view). The views are sealed as versions exactly as for a view file, and an export
job writes the data and assembles the package around it, streaming, so the data is never held in
memory. The client polls the job and downloads through the data source's export endpoints; the
download is named for the package.

**Import:**

1. `POST /api/v1/views/transfer/packages/inspect` takes the raw zip. Every part is checked against
   its checksum and size, and never decompresses past the limits, whatever the archive claims.
   The data is kept under `transfer-uploads/{uploadId}/` for 24 hours for the caller only, and the
   views are described as for a view file. Each suggested target says whether it is under version
   control (`versioned`).
2. `POST /api/v1/views/transfer/packages/{uploadId}/data` brings the data into a **new draft** of
   the target data source, through the data source's own import job, adding and updating only
   (a package never deletes). For an update, name the view (`viewId`): the draft is opened for it.
   Asking again for the same target returns the same job; the data goes with that job, so
   another target is refused with 409 and needs the file again.
3. The view is reconciled against **that draft** (`target.branchId`), so the entities the data
   brought count as found, then imported into it with `stage` set. A new view claims the draft as
   its own. The view and its data are reviewed and published together.

A package brings its data with **one** view, because a draft belongs to one view. The other views
of a multi-view package import afterwards with "View only", which treats the package as a view file.

---

## View versions

A version is created at meaningful moments, not on every autosave:

| Source | When |
|---|---|
| `baseline` | The first time a view's versions are needed (a view that predates versions). |
| `create`, `wizard` | Saving in the View wizard: one save, one version, in the same transaction as the layout write. |
| `import` | Every import, with its provenance and match report. |
| `restore` | Restoring an earlier version (the working copy is saved first if it has unsaved changes). |
| `promote` | A draft's changes to the view going live. |
| `export` | Exporting a view with unsaved changes seals them as a version first. |
| `manual` | "Save version", with an optional note. |
| `snapshot` | Unsaved changes saved automatically before an import or restore replaces them. |

A version whose definition and metadata equal the newest one's isn't created again. Listing pages
by version and never loads definitions. Compare returns metadata changes, layers added, removed,
changed and reordered, assignment counts (added, removed, moved, modified) with samples, and other
changed settings; `to` may be `working`. Restoring writes the version's definition, name,
description, icon and tags, never visibility, and says the graph data isn't affected.

---

## API

| Route | Does | Gate |
|---|---|---|
| `POST /api/v1/views/transfer/export` | `{views: [{viewId, version?}], message?}` → the file (`X-Bundle-Hash`, and for one view `X-Definition-Hash`, `X-View-Version`) | `viewExportEnabled`; read access to every view |
| `POST /api/v1/views/transfer/inspect` | raw file → bundle, integrity, identity matches, target suggestions | `viewImportEnabled` |
| `POST /api/v1/views/transfer/reconcile` | views + targets + resolutions → effective definition, report, update preview | `viewImportEnabled`; create permission in the target workspace, or edit access to the target view |
| `POST /api/v1/views/transfer/import` | one view → view, version, report, integrity (and `staged` when it went into a draft) | `viewImportEnabled`; the view-create gates, or edit access; staging needs sign-in and `workspace:datasource:manage` |
| `POST /api/v1/views/transfer/packages` | views + scope + data version → export job | `viewExportEnabled` and `graphExportEnabled`; read access; `workspace:datasource:read` |
| `POST /api/v1/views/transfer/packages/inspect` | raw zip → as inspect, plus `uploadId` and the package | `viewImportEnabled`; version control on; sign-in |
| `POST /api/v1/views/transfer/packages/{uploadId}/data` | target → the data's draft and import job | `viewImportEnabled`; version control on; the uploader; `workspace:datasource:manage` |
| `GET /api/v1/views/{viewId}/versions` | a page of versions + the working copy | read access |
| `GET …/versions/status` | head version, dirty, identity, origin | read access |
| `POST …/versions` | save a version | edit access |
| `GET …/versions/{n}`, `GET …/versions/compare?from=&to=` | one version; a diff | read access |
| `POST …/versions/{n}/restore` | restore it | edit access |
| `GET /api/v1/{wsId}/versioning/graphs/{graphId}/branches/{branchId}/view-changes` | the views a draft changes | `workspace:datasource:read` |

The transfer routes run under a 120-second timeout tier (`_TimeoutMiddleware`), below nginx's.

---

## Switches, activity and telemetry

- **Admin → Features → View versions, import and export** (`viewPortabilityEnabled`) is a
  preview, **off by default**. While it is off, Versions, Export and Import appear nowhere, and
  the server refuses every route above except `view-changes` with `403 feature_disabled`.
  Versions are still recorded, so turning it on shows each view's whole history. A draft that
  already holds an import still goes live, or is discarded, with that draft.
- **Export views** (`viewExportEnabled`) and **Import views** (`viewImportEnabled`), both on by
  default, then decide which directions are allowed. They do nothing while the preview is off.
  A view with its data needs **Export graph data** (`graphExportEnabled`) as well to export, and
  version control to import.
- **Activity**: `exported`, `imported`, `version_saved` and `version_restored` entries on the view,
  for example "Imported from dev · Finance lineage v12 · 99.5% matched".
- **Telemetry**: `view.export` (how many views, current or earlier version, with or without data)
  and `view.import` (action, strategy, whether it was staged, and the match rate as a bucket).
  Never names or URNs.

---

## Limits

`backend/app/services/view_transfer/limits.py`:

| Limit | Value |
|---|---|
| Views in one file | 200 |
| A view file | 64 MB |
| Assignments across one file | 250,000 |
| History entries carried per view | 500 |
| JSON nesting depth in a definition | 64 |
| A package, compressed | 100 MB |
| A package's data, decompressed | 2 GB |
| A package's manifest | 1 MB |

---

## Known limitations

- **URNs are not rewritten between environments.** A view matches where the environments share
  URNs; anything else is shown as not found, and can be remapped by hand on the Match step.
- **Files are not signed.** The hashes prove a file wasn't changed since it was exported, not who
  exported it.
- **A package brings one view with its data** (see above).
- **A failed package data import can't be retried in place.** Choose the file again; the draft the
  failed attempt opened is the person's to abandon.
