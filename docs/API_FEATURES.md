# Features API Contract

Admin feature flags: schema and categories come from the database; values are stored in `feature_flags`; page-level experimental notice is stored in `feature_registry_meta`. Base path: **`/api/v1/admin/features`**.

---

## GET `/api/v1/admin/features`

Returns the current feature flag schema, categories, values, experimental notice (when enabled), and last updated time.

### Response (200)

```json
{
  "schema": [
    {
      "key": "editModeEnabled",
      "name": "Edit mode",
      "description": "Allow users to edit...",
      "category": "editing",
      "type": "boolean",
      "default": true,
      "userOverridable": true,
      "options": null,
      "helpUrl": null,
      "adminHint": null,
      "sortOrder": 0,
      "deprecated": false,
      "implemented": false
    }
  ],
  "categories": [
    {
      "id": "editing",
      "label": "Editing",
      "icon": "Pencil",
      "color": "indigo",
      "sortOrder": 0,
      "preview": true,
      "previewLabel": "Not yet wired",
      "previewFooter": "Your settings here are saved..."
    }
  ],
  "values": {
    "editModeEnabled": true,
    "allowedViewModes": ["graph", "hierarchy", "reference", "layered-lineage"],
    "signupEnabled": false,
    "traceEnabled": true
  },
  "updatedAt": "2025-03-15T12:00:00.000000+00:00",
  "version": 0,
  "experimentalNotice": {
    "enabled": true,
    "title": "Early access",
    "message": "This area is in early access...",
    "updatedAt": "2025-03-15T12:00:00.000000+00:00"
  }
}
```

- **schema**: Feature definitions (from `feature_definitions`). Deprecated entries are excluded. Each has `key`, `name`, `description`, `category`, `type` (`"boolean"` \| `"string[]"`), `default`, `userOverridable`, `options` (for `string[]`), `helpUrl`, `adminHint`, `sortOrder`, `deprecated`, `implemented` (when `false`, the UI shows a “not yet wired” badge for that feature).
- **categories**: Category metadata (from `feature_categories`). Each has `id`, `label`, `icon`, `color`, `sortOrder`, and `preview`, `previewLabel`, `previewFooter` for per-card “not yet wired” copy (when `preview` is true, the UI shows the badge and footer).
- **values**: Current flag values. Keys match `schema[].key`. Missing keys use `schema[].default`.
- **updatedAt**: ISO 8601 timestamp of last PATCH, or `null` if never persisted.
- **version**: Integer, incremented on every write to feature flags (optimistic concurrency). Required in PATCH so the server can reject conflicting updates.
- **experimentalNotice**: When the notice is configured, returns `enabled` (boolean), `title`, `message`, and when enabled optionally `updatedAt` (ISO 8601). When disabled (`enabled: false`), title and message are still returned so the UI can show “Enable notice”. When no row or no title, `null`.

---

## PATCH `/api/v1/admin/features`

Updates feature flag values, experimental notice copy, and/or per-feature “implemented” (not-yet-wired) status. Feature keys are validated against DB definitions and merged with defaults.

### Request body

JSON object with **`version`** (required, integer from last GET), any subset of feature keys, and optionally **`experimentalNotice`** and **`implemented`**:

```json
{
  "version": 0,
  "editModeEnabled": false,
  "allowedViewModes": ["graph", "hierarchy"],
  "experimentalNotice": {
    "enabled": true,
    "title": "Early access",
    "message": "Optional body text..."
  },
  "implemented": {
    "editModeEnabled": true,
    "traceEnabled": false
  }
}
```

- **version** (required): integer returned by the last GET. If the stored version has changed (e.g. another admin saved), the server returns **409 Conflict** so the client can reload and retry.
- **Feature keys**: same as GET; unknown keys are rejected.
- **boolean** features: `true` or `false`.
- **string[]** features: array of option ids; at least one required; each id must be in that feature's `options`.
- **experimentalNotice** (optional): object with optional `enabled` (boolean), `title` (string, max 200 chars), `message` (string, max 2000 chars). Only provided fields are updated in the DB.
- **implemented** (optional): object mapping feature key to boolean. Sets `feature_definitions.implemented` for each key; when `true`, the UI does not show the “Not yet wired” badge for that feature. Unknown keys are rejected.

**Note:** A payload that contains only feature keys (no `experimentalNotice`) is merged with current values; missing keys keep their current value. An empty body `{}` results in all feature values being reset to schema defaults (same as “Reset to defaults” for flags).

### Response (200)

Same shape as GET: `schema`, `categories`, `values`, `updatedAt`, **`version`** (new value after this write), `experimentalNotice` (current state from DB).

### Error responses

**400 Bad Request** — Missing or invalid `version`, or other validation (unknown key, wrong type, invalid option, or “at least one required” for list types).

**409 Conflict** — Optimistic concurrency: the `version` in the request does not match the current stored version (e.g. another admin saved). Client should reload (GET), then retry PATCH with the new `version`.

```json
{
  "detail": {
    "detail": "Feature flags were updated elsewhere. Reload and try again.",
    "code": "CONFLICT",
    "field": "version"
  }
}
```

**400 Bad Request** (validation) — Validation error (unknown key, wrong type, invalid option, or “at least one required” for list types).

```json
{
  "detail": {
    "detail": "At least one option must be selected",
    "code": "VALIDATION",
    "field": "allowedViewModes"
  }
}
```

**429 Too Many Requests** — Rate limit (30 PATCH requests per 60 seconds per IP).

```json
{
  "detail": {
    "detail": "Too many updates. Please wait a moment before saving again.",
    "code": "RATE_LIMIT",
    "retryAfter": 60
  }
}
```

---

## POST `/api/v1/admin/features/definitions`

Creates a new feature definition. The new key is added to `feature_flags` with its default value.

### Request body

```json
{
  "key": "myNewFeature",
  "name": "My new feature",
  "description": "Optional description.",
  "category": "editing",
  "type": "boolean",
  "default": false,
  "userOverridable": false,
  "options": null,
  "helpUrl": null,
  "adminHint": null,
  "sortOrder": 10,
  "implemented": false
}
```

- **key** (required): unique id; must not already exist.
- **name**, **description**, **category** (category id), **type** (`boolean` | `string[]`), **default** (required).
- **options**: required when type is `string[]` (array of `{ id, label }`).
- **category** must exist in `feature_categories`.

### Response (200)

Same shape as GET. 400 if key exists or category invalid.

---

## PATCH `/api/v1/admin/features/definitions/{key}`

Updates a feature definition (metadata). Partial update: only provided fields are changed.

### Request body

Any subset of: `name`, `description`, `category`, `type`, `default`, `userOverridable`, `options`, `helpUrl`, `adminHint`, `sortOrder`, `deprecated`, `implemented`.

### Response (200)

Same shape as GET. 404 if key not found.

---

## POST `/api/v1/admin/features/definitions/{key}/deprecate`

Soft-deletes a feature: sets `deprecated=true` and removes its value from `feature_flags`. The definition remains in the DB but is excluded from schema and values.

### Response (200)

Same shape as GET. 404 if key not found.

---

## Version evolution and production behaviour

- **How versions evolve**: `feature_flags.version` is a monotonic integer. It increments by 1 on every write: PATCH (value upsert), create definition (when the new key is written into the row), and deprecate (when keys are removed). GET always returns the current version. So: client GETs → version N → user edits → client PATCHes with `version: N` → server accepts only if the row’s version is still N, then sets version to N+1.
- **Why “patching an old version” happens**: Users don’t do it on purpose. It happens when the client’s view is **stale**: e.g. two admins both load (both see version 5), one saves (version becomes 6), the other saves without reloading (sends version 5). Without OCC the second save would overwrite the first. With OCC the server returns 409 so the second client can reload and retry instead of silently overwriting.
- **Ensuring correctness**: The server performs an **atomic** update: `UPDATE feature_flags SET ... WHERE id = 1 AND version = :expected_version`. Only one concurrent PATCH can match; the other gets 0 rows updated and receives 409. So the version check is enforced in the database, not in application code, and is safe under concurrent requests.

---

## Backend data sources and migrations

- **Schema and categories**: `feature_definitions` (each has `implemented` for per-feature "not yet wired" badge), `feature_categories` (seeded at startup from `backend/app/db/seed_feature_registry.py`). Definitions support full CRUD via API.
- **Flag values**: `feature_flags` (single row). Returned values only include non-deprecated keys.
- **Experimental notice**: `feature_registry_meta` (single row: `experimental_notice_enabled`, `experimental_notice_title`, `experimental_notice_message`, `updated_at`). Seeded at startup; editable via PATCH or Admin UI "Edit notice".
- **Migrations**: Tables are created and upgraded (e.g. `feature_flags.version`) on app startup via `backend/app/db/engine.py`. For a one-off migration without starting the app: use `python backend/scripts/migrate_feature_registry.py` for full setup (all four tables); or `python backend/scripts/migrate_feature_flags.py` for the `feature_flags` table only. Both scripts are idempotent and include the `version` column.

## Frontend configuration

- **API URL**: Set `VITE_FEATURES_API_URL` for the full features endpoint, or `VITE_API_BASE_URL` for the API root (e.g. `https://api.example.com` → `/api/v1/admin/features`).
- **Fallback**: When the API is unavailable, the frontend uses generated fallback data. From the repo root, run `cd frontend && npm run generate:features-fallback` (requires Python and backend seed at `backend/app/db/seed_feature_registry.py`). This writes `frontend/src/generated/featuresFallback.json`. Regenerate after changing the backend seed so the fallback stays in sync.
- **Fail-safe**: `featuresService.get()` never throws. Order: (1) API, (2) fallback JSON (loaded at runtime), (3) hard-coded defaults (e.g. `signupEnabled: false`, `editModeEnabled: true`, `traceEnabled: true`, `allowedViewModes`) so the app never hangs or crashes when the backend or fallback file is missing or corrupt.

---

## Design summary (evaluation)

The Admin Features stack is designed for full lifecycle management with a single source of truth in the DB.

| Capability | Backend | Frontend |
|------------|---------|----------|
| **Read** schema, categories, values, notice | GET | `featuresService.get()` |
| **Update** feature values | PATCH (body: `version` + feature keys) | `featuresService.update({ ...values, version })` |
| **Update** experimental notice | PATCH (body: `experimentalNotice`) | `featuresService.update({ ..., experimentalNotice })` |
| **Update** per-feature “implemented” | PATCH (body: `implemented`) | `featuresService.update({ ..., implemented })` |
| **Create** feature definition | POST `/definitions` | `featuresService.createDefinition(body)` |
| **Update** definition metadata | PATCH `/definitions/{key}` | `featuresService.updateDefinition(key, body)` |
| **Delete** (soft) feature | POST `/definitions/{key}/deprecate` | `featuresService.deprecateDefinition(key)` |
| **Reset** values to defaults | PATCH with current `version` | `featuresService.reset(version)` |

- **Values** returned by GET (and used in validation) only include non-deprecated keys. Deprecating a feature removes it from `feature_flags` config and from the response.
- **Categories** are still seed-only; definition CRUD validates that `category` exists. Adding category CRUD would follow the same pattern (repo + routes + service).
- **Frontend** components are schema-driven: they render from `schema` and `categories`; new or updated definitions appear after reload or after calling `createDefinition` / `updateDefinition` / `deprecateDefinition` and refreshing state from the returned response.
