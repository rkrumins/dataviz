# Feature Switches API

*For integrators and engineers who read or change feature switches through the API, or need
to know which endpoint a switch turns off.*

This page is the reference for the feature-switch API behind **Administration → Features**:
every route with its request and answer, how a change is saved safely, and all 28 switches
with their defaults and the server routes each one controls.

- **Administrators:** what each switch does on screen, and how to change one, is in
  [Feature Switches](/guide/feature-switches).
- **Contributors:** adding, shipping or retiring a switch is in
  [Feature flags: adding one, and ending one](/docs/feature-flags-lifecycle).

> **Before you start:** every route under `/api/v1/admin/features` needs `system:admin` (the
> **Super admin** role). Scripts sign in as described in
> [Sign in from a script](/docs/api-guide#sign-in-from-a-script).

## How to read this page

A **switch** has a **definition** (its key, the name and help an administrator reads, its type
and default) and a **value** (what is in force now). Three types exist:

| Type | Value | Example |
|---|---|---|
| `boolean` | `true` or `false` | `traceEnabled` |
| `string[]` | A list of the option ids it governs; at least one | `allowedViewModes` |
| `string` | Exactly one option id — a choice between levels | `enterpriseViewPolicy` |

Every switch also has a **posture**, which decides what the server assumes when it can't read
the value (a database blip): a **capability** switch fails open — the feature stays available —
and a **security** switch fails closed. Its **stage** is `active`, `experimental` (a preview
that ships off) or `deprecated` (on its way out).

## Routes

| Method · path | What it does |
|---|---|
| `GET /api/v1/admin/features` | Every definition, category and value, the change log's latest entries, and the version to save against |
| `PATCH /api/v1/admin/features` | Save values, and the page's preview notice |
| `POST /api/v1/admin/features/definitions` | Add a definition of your own |
| `PATCH /api/v1/admin/features/definitions/{key}` | Change a definition |
| `POST /api/v1/admin/features/definitions/{key}/deprecate` | Retire a definition |
| `GET /api/v1/admin/features/{key}/history` | Every change to one switch, newest first |
| `GET /api/v1/admin/features/{key}/impact` | What turning one switch off would touch here |

To read only the values — what the app loads when it starts — use
`GET /api/v1/features/values`, which answers `{values, version, updatedAt}`.

## Read the switches

`GET /api/v1/admin/features` answers:

```json
{
  "schema": [
    {
      "key": "traceEnabled",
      "name": "Lineage trace",
      "description": "Follow a node's lineage upstream and downstream across the graph, from the graph and context views.",
      "impactWhenOff": "The Trace button disappears from the toolbars and the server refuses trace requests. …",
      "category": "lineage",
      "type": "boolean",
      "default": true,
      "options": null,
      "helpUrl": null,
      "adminHint": "Trace can be expensive on very large graphs. …",
      "sortOrder": 1,
      "deprecated": false,
      "stage": "active",
      "posture": "capability",
      "implemented": true,
      "enforcedServerSide": true,
      "serverGates": ["POST /graph/trace — upstream/downstream lineage traversal"],
      "uiSurfaces": ["Trace button in the graph and context view toolbars"],
      "stillAllowed": ["Browsing and expanding the graph by hand"],
      "dependsOn": []
    }
  ],
  "categories": [
    {"id": "lineage", "label": "Lineage", "icon": "GitBranch", "color": "amber", "sortOrder": 3,
     "preview": false, "previewLabel": null, "previewFooter": null}
  ],
  "values": {"traceEnabled": true, "allowedViewModes": ["graph", "hierarchy", "reference", "layered-lineage"], "…": "…"},
  "updatedAt": "2026-10-01T09:30:00+00:00",
  "version": 4,
  "experimentalNotice": {"enabled": true, "title": "Early access", "message": "…"},
  "lastChanges": {
    "traceEnabled": {"id": "…", "key": "traceEnabled", "from": true, "to": false,
                     "actorId": "usr_…", "actorName": "Dana Smith", "at": "2026-10-01T09:30:00+00:00"}
  }
}
```

- **`schema`** — the definitions, deprecated ones left out. `stage`, `posture`, `implemented`,
  `enforcedServerSide`, `serverGates`, `uiSurfaces`, `stillAllowed` and `dependsOn` are facts
  read from the code (`backend/app/config/feature_wiring.py`), not from the database: no request
  can change them. `implemented` is `true` when the switch changes anything at all.
- **`values`** — every switch's value in force: the saved value, or the definition's default
  where nothing has been saved.
- **`version`** — the token you send back when you save.
- **`experimentalNotice`** — the banner text on the Features page; `null` when there is none.
- **`lastChanges`** — the most recent change to each switch that has ever changed.

## Change switch values

A save replaces the whole set of values, so always start from what is there now.

1. Read the current values and version:

   ```bash
   api GET /api/v1/admin/features | jq '{version, values}' > features.json
   ```

2. Change the keys you mean to, keeping every other key, and send them with the version:

   ```bash
   jq '.values + {traceEnabled: false, version: .version}' features.json |
     api PATCH /api/v1/admin/features -d @- | jq '{version, traceEnabled: .values.traceEnabled}'
   ```

   The answer has the same shape as the read, with the new `version`.

3. Allow up to 30 seconds for every server process to act on the change: each one keeps the
   values for 30 seconds, and only the process that handled your save forgets them at once.

> **Warning:** A key you leave out is reset to its default — the server merges what you send
> onto the definitions' defaults, not onto the saved values. A body of just `{"version": 4}`
> resets every switch. Send every key from `values`, as the steps above do.

| Answer | `detail.code` | When |
|---|---|---|
| `400` | `VALIDATION` | `version` missing; an unknown key; a value of the wrong type; an option the switch doesn't govern; an empty `string[]` |
| `400` | `READ_ONLY` | The body has `implemented` — it comes from the code and can't be set |
| `400` | `EXPERIMENTAL_NOTICE_VALIDATION` | `experimentalNotice.title` over 200 characters, or `message` over 2,000 |
| `409` | `CONFLICT` | Someone saved since your read. Read again, re-apply your change, save again |
| `429` | `RATE_LIMIT` | More than 30 saves in 60 seconds from one address; the body says `retryAfter` |

Errors here nest one level: `{"detail": {"detail": "…", "code": "…", "field": "…"}}`.

To change the preview notice in the same save, add
`"experimentalNotice": {"enabled": true, "title": "…", "message": "…"}`; fields you leave out
keep their value. Every save records who changed which switch from what to what — that log is
what `lastChanges` and `/{key}/history` read.

## Add, change and retire definitions

The 28 built-in switches ship with the code. These routes add switches of your own and adjust
definitions; they answer the same shape as the read.

**Add** — `POST /api/v1/admin/features/definitions`:

```json
{"key": "myNewFeature", "name": "My new feature", "description": "What it does.",
 "category": "editing", "type": "boolean", "default": false,
 "helpUrl": null, "adminHint": null, "sortOrder": 10}
```

`key`, `name`, `description`, `category` (an existing category id), `type` and `default` are
required. `type` is `boolean` or `string[]`; a `string[]` switch also needs
`options: [{"id", "label"}]`. A definition added here has no gate in the code, so it reports
`implemented: false` until someone wires it.

**Change** — `PATCH /api/v1/admin/features/definitions/{key}` takes any of `name`,
`description`, `category`, `type`, `default`, `options`, `helpUrl`, `adminHint`,
`impactWhenOff`, `sortOrder` and `deprecated`.

> **Warning:** `options`, `helpUrl`, `adminHint` and `impactWhenOff` are cleared when you leave
> them out. Send their current values with every change.

> **Note:** For the 28 built-in switches, the API service rewrites `name`, `description`,
> `adminHint`, `impactWhenOff`, `helpUrl`, `category`, `type`, `options` and `sortOrder` from
> the code every time it starts, so a change to those lasts only until the next restart.
> Change the text in `backend/app/config/features_seed.py` instead.

**Retire** — `POST /api/v1/admin/features/definitions/{key}/deprecate` marks the definition
deprecated and removes its value. It stays in the database, but leaves `schema` and `values`.
An unknown key answers `404`.

## Read one switch's history and impact

- `GET /api/v1/admin/features/{key}/history?limit=20` (1–500) answers `{key, history}`; each
  entry is `{id, key, from, to, actorId, actorName, at}`. A retired switch keeps its history.
- `GET /api/v1/admin/features/{key}/impact` counts what turning the switch off would touch in
  this deployment: `{known: true, facts: [{count, label, consequence, tone, detail}]}`.
  `known: false` means the count is not available — not that nothing would be affected.

## Feature flags (authoritative set)

All 28 switches, grouped as **Administration → Features** groups them. **Switch** is the name
an administrator sees. **When it is off** names the routes the server refuses — `403` with
`{"detail": {"type": "feature_disabled", "feature": "<key>", "message": "…"}}` unless the row
says otherwise — or what it does instead. Paths are relative to `/api/v1`. Every switch whose
stage is `active` is enforced by the server; a switch that only hid a button would leave the
feature open to anyone who knows the URL.

### Analytics

| Switch | Key | Default | When it is off | Notes |
|---|---|---|---|---|
| Analytics for everyone | `analyticsPublicEnabled` | Off | `GET /admin/analytics/*` refuses anyone without `system:audit:read`, `system:org-admin` or `system:admin`. On, they get a redacted view | Security |
| What everyone can see | `analyticsPrivacyMode` | Show colleagues (`internal`) | Not a switch: `GET /admin/analytics/*` shows a non-privileged reader aggregates only (`strict`, Aggregate only), adds people (`internal`, Show colleagues), or adds operational health too (`full`, Show colleagues and operations) | Security; an unreadable value acts as `strict` |
| Show every workspace in Analytics | `analyticsWorkspaceVisibility` | Off | `GET /admin/analytics/*` reports only the workspaces the reader belongs to; others are counted but unnamed. On, it names every workspace — it grants no access to them | Security |
| Let people contact each other from Analytics | `analyticsShowEmailAddresses` | Off | `GET /admin/analytics/*` leaves out the email address beside a view's creator and a workspace's contributors | Security; never on the platform-wide ranking |

### Editing

| Switch | Key | Default | When it is off | Notes |
|---|---|---|---|---|
| Edit mode | `editModeEnabled` | On | `POST /{ws_id}/graph/nodes/create`, `POST /{ws_id}/graph/edges`, `PATCH` and `DELETE /{ws_id}/graph/edges/{edge_id}`, `POST /{ws_id}/graph/changes` | Reading and exporting keep working |

### View Modes

| Switch | Key | Default | When it is off | Notes |
|---|---|---|---|---|
| View modes | `allowedViewModes` | All four: Graph (`graph`), Hierarchy (`hierarchy`), Context View (`reference`), Layered Lineage (`layered-lineage`) | A list, not a switch: `POST /views` and `PUT /views/{view_id}` refuse a view type that isn't in it | Views already built in a removed type keep working. At least one must stay |

### Authentication

| Switch | Key | Default | When it is off | Notes |
|---|---|---|---|---|
| Self-registration | `signupEnabled` | Off | `POST /auth/signup` refuses a sign-up that carries no valid invite | Security. Invited people can always sign up |
| Invite links | `inviteLinksEnabled` | On | `POST /admin/users/invite` and `/admin/users/invite/bulk` refuse to create links; `GET /auth/verify-invite` reports every link unusable; `POST /auth/signup` and `POST /auth/redeem-invite` refuse invite links with `400` | Kills links already sent; turning it back on revives those that haven't expired |

### Lineage

| Switch | Key | Default | When it is off | Notes |
|---|---|---|---|---|
| Version control | `versioningEnabled` | On | Every `POST`, `PUT`, `PATCH` and `DELETE` under `/{ws_id}/versioning/` except `…/projection/rebuild`, `…/projection/reconcile` and `POST …/exports`; `POST /{ws_id}/graph/bootstrap`, `…/bootstrap/retry`, `…/bootstrap/abandon` and `POST /{ws_id}/graph/resync`; view packages and staging a view import in a draft; and every write through a versioned graph | Reads stay open and history is kept. The widest switch: it withdraws editing too |
| Lineage trace | `traceEnabled` | On | `POST /{ws_id}/graph/trace/v2`, `…/trace/closure`, `…/trace/expand`, `…/trace/expand-batch`, and the retired `…/trace` | Browsing and expanding by hand keep working |

### Data Governance

| Switch | Key | Default | When it is off | Notes |
|---|---|---|---|---|
| Export graph data | `graphExportEnabled` | On | With version control: `GET …/versioning/graphs/{graph_id}/exports/plan` and `/exports/stream`, `POST …/exports`, `GET …/exports/{job_id}/download`. Without: `GET /{ws_id}/graph/export/plan` and `/stream`. Search: `POST /{ws_id}/graph/search/exports` and its download. View packages: `POST /views/transfer/packages` | Files already downloaded are not recalled |
| Publishing views to everyone | `enterpriseViewPolicy` | Workspaces decide (`workspaces`) | A ceiling, not a switch. `off` (Not available): `POST /views` as Enterprise, `PUT /views/{view_id}/visibility` to Enterprise and `POST /views/{view_id}/publish-request/approve` refuse. `request` (Always require approval): someone without the publish permission must ask, and a publisher approves | Unpublishing is never blocked. An unreadable value acts as `workspaces` |
| Build lineage from scratch | `blankModelsEnabled` | On | `POST /{ws_id}/versioning/blank-graphs` | Needs Version control. Models already built keep working |
| View versions, import and export | `viewPortabilityEnabled` | Off | Every `/views/transfer/*` and `/views/{view_id}/versions/*` route | Experimental preview. Versions keep being recorded while it is off |
| Export views | `viewExportEnabled` | On | `POST /views/transfer/export`, `/views/transfer/export/preview`, `/views/transfer/packages` | Needs View versions, import and export |
| Import views | `viewImportEnabled` | On | `POST /views/transfer/inspect`, `/reconcile`, `/import`, `/packages/inspect`, `/packages/{upload_id}/data` | Needs View versions, import and export |

### Display & UI

| Switch | Key | Default | When it is off | Notes |
|---|---|---|---|---|
| Node sorting controls | `nodeSortingEnabled` | On | Not refused: every view-layout write has `nodeSortMode`, `orderKey` and `defaultNodeSortMode` stripped out, so a canvas save still succeeds | Orders already saved still render |

### Semantic Layers

| Switch | Key | Default | When it is off | Notes |
|---|---|---|---|---|
| Edit semantic layers | `semanticLayerEditMode` | On | `POST /admin/ontologies`, `PUT` and `DELETE /admin/ontologies/{ontology_id}`, `POST …/{ontology_id}/restore`, `…/{ontology_id}/new-version`, `POST /admin/ontologies/import` and `…/{ontology_id}/import` — for everyone, administrators included | Publishing, cloning and exporting keep working |
| Let non-admins edit layers | `semanticLayerNonAdminEditing` | On | Every semantic-layer write (create, update, delete, restore, new version, publish, clone, import) refuses anyone without `system:admin` or `system:org-admin` | Security: an unreadable value means administrators only. Needs Edit semantic layers |
| Import layers | `semanticLayerImportEnabled` | On | `POST /admin/ontologies/import`, `POST /admin/ontologies/{ontology_id}/import` | Needs Edit semantic layers |
| Export layers | `semanticLayerExportEnabled` | On | `GET /admin/ontologies/{ontology_id}/export` | |
| Suggest from graph | `semanticLayerAutoSuggest` | On | `POST /admin/ontologies/suggest` | Choosing a layer by hand keeps working |
| Layer history & audit | `semanticLayerVersionHistory` | On | `GET /admin/ontologies/{ontology_id}/versions`, `GET /admin/ontologies/{ontology_id}/audit` | Hidden, not deleted |

### Notifications

| Switch | Key | Default | When it is off | Notes |
|---|---|---|---|---|
| Announcements | `announcementsEnabled` | On | Not refused: `GET /announcements` answers an empty list | Announcements are hidden, not deactivated |

### Experimental

| Switch | Key | Default | When it is off | Notes |
|---|---|---|---|---|
| Guided product tours | `toursEnabled` | Off | Nothing on the server — the app shows no tours | Experimental, in the app only |
| Fold distant layers | `canvasLayerFoldEnabled` | Off | Nothing on the server — the Context View offers no **Fold** button | Experimental, in the app only |
| Roll up lineage to unloaded entities | `canvasLineageRollupEnabled` | Off | Nothing: the switch is retired and nothing reads it | Deprecated; to be removed |
| One placement rule for every view surface | `placementContractEnabled` | Off | While it is **on**: `POST /{ws_id}/graph/assignments/compute` places entities with one shared rule; a view-scoped import pins a new top-level entity to a layer only where that rule would place it elsewhere; `POST /views` and `PUT /views/{view_id}/layout` refuse a new or changed layer rule that can never match | Experimental. Read with "off" as the fallback |

## How a switch is enforced

| Gate | File · symbol | Used for |
|---|---|---|
| Per route: refuse when off | `backend/app/api/v1/feature_gate.py` · `require_feature` | Most switches |
| Per router: refuse every write, keep reads | `backend/app/api/v1/versioning_gate.py` · `versioning_write_gate` | Version control |
| Refuse non-administrators only | `feature_gate.py` · `require_admin_unless` | Let non-admins edit layers |
| A list of allowed values | `feature_gate.py` · `ensure_view_mode_allowed` | View modes |
| A level, not a switch | `feature_gate.py` · `resolve_enterprise_view_policy` | Publishing views to everyone |
| Strip instead of refuse | `backend/app/db/repositories/view_repo.py` · `_gate_node_ordering` | Node sorting controls |
| A refusal raised deeper in a service | `backend/app/services/feature_flags.py` · `FeatureDisabledError`, answered by `_feature_disabled_handler` in `backend/app/main.py` | Writes through a versioned graph |

Each gate reads the value through `backend/app/services/feature_flags.py` (`feature_flags`),
which keeps it for 30 seconds, and falls back by posture (`fail_safe_default` in
`backend/app/config/feature_wiring.py`). The message in a refusal comes from
`REFUSAL_MESSAGES` in `backend/app/config/features_seed.py`.

## Where the data lives

| What | Where | Owned by |
|---|---|---|
| Definitions | `feature_definitions` table | The code: the 28 built-in definitions are seeded, and their text and structure rewritten, each time the API service starts |
| Categories | `feature_categories` table | The code: seeded the same way |
| Values and version | `feature_flags` table, one row | Administrators: seeded once with the defaults, never reset by a deployment |
| Change log | `feature_flag_changes` table | Written by every save |
| Preview notice | `feature_registry_meta` table, one row | Administrators |

The tables themselves are created and upgraded by the `upgrade` job
(`python -m backend.scripts.upgrade upgrade`, which runs the Alembic migrations), never by the
API service; the API refuses readiness until the schema is current. The seeding is
`seed_feature_registry`, `seed_feature_flags` and `seed_feature_registry_meta` in
`backend/app/db/seed_feature_registry.py`. A switch added after the first seed has no saved
value, so it reads as its default until an administrator saves.

**In the app.** The frontend calls the same routes, relative to its own address. Two
fallbacks keep it working when it can't read them:

- The app reads the values from `GET /api/v1/features/values` at start, again whenever its
  tab becomes visible, and on a slow timer while it stays open (`loadFeatures()` and
  `startFeaturesSync()` in `frontend/src/store/features.ts`). Until then, and whenever the
  fetch fails, it uses `DEFAULT_FEATURES`, which mirror the server's defaults — except that
  security switches read as closed and previews as off. The server's `403` is the real
  enforcement either way.
- The Features page's `featuresService.get()` never throws: it falls back from the API to a
  generated file (`frontend/src/generated/featuresFallback.json`, rebuilt before every build,
  or by `npm run generate:features-fallback` in `frontend/`) and then to a short built-in list
  (`FAILSAFE_VALUES` in `frontend/src/services/featuresService.ts`).

## Where in the code

| Concern | File | Symbol |
|---|---|---|
| Routes | `backend/app/api/v1/endpoints/features.py` | `get_features`, `patch_features`, `create_definition`, `patch_definition`, `deprecate_definition`, `get_feature_history`, `get_feature_impact`, `get_feature_values` |
| Mounting and the `system:admin` gate | `backend/app/api/v1/api.py` | `features.router`, `features.public_router` |
| Value validation and the merge onto defaults | `backend/app/config/features.py` | `validate_and_merge_values` |
| Saving with the version check | `backend/app/db/repositories/feature_flags_repo.py` | `upsert_feature_flags`, `record_changes`, `get_last_changes` |
| Definition rows | `backend/app/db/repositories/feature_registry_repo.py` | `_row_to_definition`, `update_definition` |
| Built-in text and defaults | `backend/app/config/features_seed.py` | `SEED_DEFINITIONS`, `SEED_CATEGORIES`, `REFUSAL_MESSAGES` |
| What each switch enforces | `backend/app/config/feature_wiring.py` | `FEATURE_WIRING`, `wiring_payload` |
| Impact counts | `backend/app/services/feature_impact.py` | `probe` |
| The app's client and fallbacks | `frontend/src/services/featuresService.ts`, `frontend/src/store/features.ts` | `featuresService` |

## See also

- [Feature Switches](/guide/feature-switches) — what each switch does, for administrators.
- [Feature flags: adding one, and ending one](/docs/feature-flags-lifecycle) — the rules for
  adding and retiring a switch, and the test that enforces them.
- [API Guide for Integrators](/docs/api-guide) — signing in, conventions and errors.
- [RBAC](/docs/rbac) — the roles and permissions named on this page.
- [Backend](/docs/backend) — where these routes sit among the others.
