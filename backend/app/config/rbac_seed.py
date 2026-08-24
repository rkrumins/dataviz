"""Canonical RBAC reference data: permissions, system roles, and grants.

CONTENT lives here; the machinery that writes it lives in
backend.app.db.seed_reference_data. Same split as
app/config/features_seed.py vs app/db/seed_feature_registry.py.

These rows were, until now, reachable only by replaying migrations
20260430_1200_rbac_schema through 20260606_0100_role_expansion.
That was fine while every install replayed the whole chain, and became a
hole the moment a fresh install stopped doing so: create_all builds
the tables but not one row of reference data, and a database with zero
permissions and zero roles cannot authorise anybody.

The historical migrations stay frozen and keep seeding existing
databases. This module is what a fresh install uses instead, and CI holds
the two paths to the same result — if a future change seeds a permission
in one path and not the other, the convergence job fails.

Only is_system roles belong here. Roles an operator creates are their
data, not reference data.
"""
from __future__ import annotations

#: permissions rows. examples is a JSON array serialised into TEXT.
PERMISSIONS: tuple[dict[str, str | None], ...] = (
    {
        "id": "system:admin",
        "category": "system",
        "description": "Full system control; implies every other permission.",
        "long_description": "Full administrative authority over the entire platform — implies every other permission. Reserved for trusted operators who oversee global configuration and security.",
        "examples": "[\"Manage every workspace's settings\", \"Change any user's role from User to Admin\", \"Create and delete workspaces\", \"Override every other permission check\"]",
    },
    {
        "id": "system:analytics:read",
        "category": "system",
        "description": "Read platform analytics — growth, engagement and adoption.",
        "long_description": "Lets you open the Analytics section and see platform-wide growth, engagement and adoption, including per-person activity and operational health. Deliberately SEPARATE from system:audit:read: business metrics are not the audit log, and someone who should see how the platform is growing does not automatically need every login and RBAC mutation. Workspace-level detail still follows the normal workspace permissions — this grants no access to a workspace you are not otherwise entitled to.",
        "examples": "[\"See how many people signed up this quarter and how many are still active.\", \"Find which views the organisation actually opens.\"]",
    },
    {
        "id": "system:sso:hosts:manage",
        "category": "system",
        "description": "Manage which internal hosts SSO may call back to.",
        "long_description": "Lets you add and remove entries in the back-channel host allowlist — the internal addresses a back-channel SSO provider is permitted to call during a login. Deliberately SEPARATE from system:admin, because an entry lets this service make requests to an address on your internal network: the list is the only thing standing between an SSO configuration form and a request-forgery tool, so who may edit it is a decision worth making on its own. It grants no access to provider settings or to anyone's identity, and no entry can ever unlock loopback or the cloud metadata service.",
        "examples": "[\"Allow sso-gateway.corp.internal:443 so a new back-channel provider can reach it.\", \"Remove a gateway that has been decommissioned.\"]",
    },
    {
        "id": "system:audit:read",
        "category": "system",
        "description": "Read the platform audit log (logins, RBAC mutations, sessions).",
        "long_description": "Lets you read the platform-wide audit log — successful and failed logins, RBAC mutations (role creates/updates, binding grants), and session revocations. Does NOT permit any mutation.",
        "examples": "[\"Review who signed in over the last 30 days.\", \"Confirm a binding was revoked by checking the audit log.\"]",
    },
    {
        "id": "system:bindings:read",
        "category": "system",
        "description": "List role bindings and per-user effective access cross-workspace.",
        "long_description": "Lets you list every role binding in the system and inspect any user's effective permissions and group memberships. Powers the 'By user' / 'By workspace' admin tabs for compliance reviewers.",
        "examples": "[\"Answer 'why does Alice see Finance workspace?'\", \"Compile a per-workspace member roster for a compliance review.\"]",
    },
    {
        "id": "system:groups:manage",
        "category": "system",
        "description": "Create, edit, delete groups and manage their members.",
        "long_description": None,
        "examples": None,
    },
    {
        "id": "system:org-admin",
        "category": "system",
        "description": "Cross-workspace operator; implies every workspace permission.",
        "long_description": None,
        "examples": None,
    },
    {
        "id": "system:org-viewer",
        "category": "system",
        "description": "Read-only operator across every workspace in the tenancy.",
        "long_description": "Lets you see every workspace's data sources, views, ontologies, catalog items, and providers without being able to modify any of them. The resolver short-circuits every workspace:*:read in any workspace when this permission is held, so a single global binding covers cross-tenancy visibility.",
        "examples": "[\"Open any workspace and see its data sources, ontology, and views.\", \"Drill into a provider's status without being able to edit it.\"]",
    },
    {
        "id": "system:users:manage",
        "category": "system",
        "description": "Create, approve, suspend, and change roles for users.",
        "long_description": None,
        "examples": None,
    },
    {
        "id": "system:workspaces:create",
        "category": "system",
        "description": "Create new workspaces.",
        "long_description": None,
        "examples": None,
    },
    {
        "id": "workspace:admin",
        "category": "workspace",
        "description": "Manage workspace settings, members, and deletion.",
        "long_description": "Full administrative authority within a single workspace — settings, members, deletion, and all data inside. Doesn't grant access to other workspaces.",
        "examples": "[\"Edit the workspace's name and description\", \"Add or revoke workspace members\", \"Delete the workspace\", \"Hard-delete views authored by other members\"]",
    },
    {
        "id": "workspace:catalog:manage",
        "category": "workspace",
        "description": "Promote / edit / delete catalog items the workspace owns.",
        "long_description": "Lets you promote raw provider namespaces into catalog items, edit their metadata, archive or delete them, within the workspaces you administer.",
        "examples": "[\"Promote a provider namespace into a catalog item.\", \"Archive a catalog item the workspace no longer needs.\"]",
    },
    {
        "id": "workspace:catalog:read",
        "category": "workspace",
        "description": "Read catalog items (curated data assets) available to the workspace.",
        "long_description": "Lets you browse catalog items (curated, named data assets) available to your workspace, including provider links and binding state.",
        "examples": "[\"Browse the catalog of curated data assets in the Ingestion page.\"]",
    },
    {
        "id": "workspace:datasource:manage",
        "category": "workspace",
        "description": "Connect, edit, and delete data sources in a workspace.",
        "long_description": "Connect new data sources, edit their configuration, and remove them from a workspace. Required for workspace setup and ongoing maintenance.",
        "examples": "[\"Connect a new FalkorDB graph\", \"Change the ontology assigned to a data source\", \"Delete a data source from the workspace\"]",
    },
    {
        "id": "workspace:datasource:read",
        "category": "workspace",
        "description": "List and use workspace data sources in views.",
        "long_description": "List the data sources attached to a workspace and use them in views. Doesn't allow modification.",
        "examples": "[\"See which data sources are connected to the workspace\", \"Pick a data source when creating a new view\", \"Read cached statistics for a data source\"]",
    },
    {
        "id": "workspace:ontology:manage",
        "category": "workspace",
        "description": "Create, edit, version, publish, and delete ontologies in the workspace.",
        "long_description": "Lets you create new ontology drafts, edit definitions, version, publish, restore, clone, and delete ontologies within the workspaces you administer.",
        "examples": "[\"Create a new draft ontology.\", \"Publish a draft into a new immutable version.\", \"Delete an unused ontology.\"]",
    },
    {
        "id": "workspace:ontology:read",
        "category": "workspace",
        "description": "Read ontologies (semantic layers) that the workspace's data sources reference.",
        "long_description": "Lets you view every ontology (entity types, relationships, versions, coverage) that any data source in your workspace is assigned to. You cannot create, edit, or publish ontologies.",
        "examples": "[\"Open the Semantic Layers page and see the ontologies your workspace uses.\", \"Inspect entity/relationship definitions and coverage stats.\"]",
    },
    {
        "id": "workspace:provider:read",
        "category": "workspace",
        "description": "Read providers (database connections) that back the workspace's data sources.",
        "long_description": "Lets you see which providers (database connections) back the data sources in your workspace, including connection status and last-checked time. Credentials are NEVER returned. You cannot edit, test, or delete providers.",
        "examples": "[\"Open the Ingestion \\u2192 Providers tab and see the providers your workspace uses.\", \"Read the provider's status (ready / unavailable).\"]",
    },
    {
        "id": "workspace:view:create",
        "category": "workspace",
        "description": "Create new views in a workspace.",
        "long_description": "Create new views in a workspace. Doesn't grant the right to edit or delete views authored by other members — that requires `workspace:view:edit` / `workspace:view:delete`.",
        "examples": "[\"Create a new graph view\", \"Save a draft view as private\", \"Create an analytical dashboard\"]",
    },
    {
        "id": "workspace:view:delete",
        "category": "workspace",
        "description": "Soft-delete any view in a workspace.",
        "long_description": "Soft-delete any view in this workspace. Hard-delete (`permanent=true`) requires `workspace:admin`. The view's creator can always delete their own work regardless of this permission.",
        "examples": "[\"Soft-delete an obsolete view\", \"Clean up old draft views\", \"Remove a colleague's deprecated dashboard\"]",
    },
    {
        "id": "workspace:view:edit",
        "category": "workspace",
        "description": "Edit any view in a workspace.",
        "long_description": "Edit any view in this workspace, including views authored by other workspace members. Cannot delete views — that requires `workspace:view:delete`.",
        "examples": "[\"Update an existing view's configuration\", \"Rename a view someone else created\", \"Change a view's data source\"]",
    },
    {
        "id": "workspace:view:publish",
        "category": "workspace",
        "description": "Publish views to everyone in the organization (enterprise visibility).",
        "long_description": "Move views to and from enterprise visibility — making them visible to every signed-in user on the platform, with read-only access to the underlying data. Changing a view between private and workspace visibility does not need this permission.",
        "examples": "[\"Publish a curated lineage view for the whole organization.\", \"Unpublish an enterprise view back to workspace visibility.\"]",
    },
    {
        "id": "workspace:view:read",
        "category": "workspace",
        "description": "List and open views in a workspace.",
        "long_description": "List and open views in a workspace. Read-only — doesn't allow editing or managing explicit shares.",
        "examples": "[\"Browse the workspace's views catalogue\", \"Open a graph view to inspect the data\", \"Export a view as JSON\"]",
    },
)

#: roles rows. Every one is is_system=True with scope_id=NULL.
SYSTEM_ROLES: tuple[dict[str, str | None], ...] = (
    {
        "name": "org_admin",
        "scope_type": "global",
        "description": "Cross-workspace operator — manage every workspace + create new ones, but no user/SSO admin.",
    },
    {
        "name": "org_auditor",
        "scope_type": "global",
        "description": "Read-only operator across the whole tenancy. Sees every workspace + every binding + the audit log; cannot mutate.",
    },
    {
        "name": "super_admin",
        "scope_type": "global",
        "description": "Platform owner. Carries system:admin; implies every permission, every scope.",
    },
    {
        "name": "workspace_admin",
        "scope_type": "global",
        "description": "Workspace administrator — settings, members, deletion, and every workspace permission (via auto-implication).",
    },
    {
        "name": "workspace_data_engineer",
        "scope_type": "global",
        "description": "Owns data products inside a workspace (datasources, ontology, catalog, views) without managing members or workspace settings.",
    },
    {
        "name": "workspace_member",
        "scope_type": "global",
        "description": "Standard workspace member — manage views and data sources.",
    },
    {
        "name": "workspace_viewer",
        "scope_type": "global",
        "description": "Read-only access to the bound workspace's views + data sources.",
    },
)

#: role_permissions rows as (role_name, permission_id).
ROLE_GRANTS: tuple[tuple[str, str], ...] = (
    ("org_admin", "system:groups:manage"),
    ("org_admin", "system:org-admin"),
    ("org_admin", "system:workspaces:create"),
    ("org_admin", "workspace:admin"),
    ("org_admin", "workspace:catalog:manage"),
    ("org_admin", "workspace:catalog:read"),
    ("org_admin", "workspace:datasource:manage"),
    ("org_admin", "workspace:datasource:read"),
    ("org_admin", "workspace:ontology:manage"),
    ("org_admin", "workspace:ontology:read"),
    ("org_admin", "workspace:provider:read"),
    ("org_admin", "workspace:view:create"),
    ("org_admin", "workspace:view:delete"),
    ("org_admin", "workspace:view:edit"),
    ("org_admin", "workspace:view:publish"),
    ("org_admin", "workspace:view:read"),
    ("org_admin", "system:analytics:read"),
    ("org_auditor", "system:analytics:read"),
    ("org_auditor", "system:audit:read"),
    ("org_auditor", "system:bindings:read"),
    ("org_auditor", "system:org-viewer"),
    ("super_admin", "system:admin"),
    ("super_admin", "system:analytics:read"),
    ("super_admin", "system:audit:read"),
    ("super_admin", "system:bindings:read"),
    ("super_admin", "system:groups:manage"),
    ("super_admin", "system:org-admin"),
    ("super_admin", "system:org-viewer"),
    # super_admin only, deliberately. org_admin runs the platform; this
    # one decides where the platform may send requests, which is a
    # network decision rather than an administrative one.
    ("super_admin", "system:sso:hosts:manage"),
    ("super_admin", "system:users:manage"),
    ("super_admin", "system:workspaces:create"),
    ("super_admin", "workspace:admin"),
    ("super_admin", "workspace:catalog:manage"),
    ("super_admin", "workspace:catalog:read"),
    ("super_admin", "workspace:datasource:manage"),
    ("super_admin", "workspace:datasource:read"),
    ("super_admin", "workspace:ontology:manage"),
    ("super_admin", "workspace:ontology:read"),
    ("super_admin", "workspace:provider:read"),
    ("super_admin", "workspace:view:create"),
    ("super_admin", "workspace:view:delete"),
    ("super_admin", "workspace:view:edit"),
    ("super_admin", "workspace:view:publish"),
    ("super_admin", "workspace:view:read"),
    ("workspace_admin", "workspace:admin"),
    ("workspace_data_engineer", "workspace:catalog:manage"),
    ("workspace_data_engineer", "workspace:catalog:read"),
    ("workspace_data_engineer", "workspace:datasource:manage"),
    ("workspace_data_engineer", "workspace:datasource:read"),
    ("workspace_data_engineer", "workspace:ontology:manage"),
    ("workspace_data_engineer", "workspace:ontology:read"),
    ("workspace_data_engineer", "workspace:provider:read"),
    ("workspace_data_engineer", "workspace:view:create"),
    ("workspace_data_engineer", "workspace:view:delete"),
    ("workspace_data_engineer", "workspace:view:edit"),
    ("workspace_data_engineer", "workspace:view:read"),
    ("workspace_member", "workspace:catalog:read"),
    ("workspace_member", "workspace:datasource:manage"),
    ("workspace_member", "workspace:datasource:read"),
    ("workspace_member", "workspace:ontology:read"),
    ("workspace_member", "workspace:provider:read"),
    ("workspace_member", "workspace:view:create"),
    ("workspace_member", "workspace:view:delete"),
    ("workspace_member", "workspace:view:edit"),
    ("workspace_member", "workspace:view:read"),
    ("workspace_viewer", "workspace:catalog:read"),
    ("workspace_viewer", "workspace:datasource:read"),
    ("workspace_viewer", "workspace:ontology:read"),
    ("workspace_viewer", "workspace:provider:read"),
    ("workspace_viewer", "workspace:view:read"),
)
