"""The default CONTENT of the feature registry — the prose an admin reads before flipping a switch.

Split out of ``db/seed_feature_registry.py`` (which keeps the DB machinery) for two reasons:

  * it is content, not persistence — the seeding procedure and the words being seeded are
    different concerns and change for different reasons;
  * it imports nothing but ``json``, so the drift guard (``tests/test_feature_wiring.py``)
    can hold it against the code with no database, no SQLAlchemy and no FastAPI — which is
    what lets that guard run as a cheap CI job instead of only inside the dev container.

WHAT LIVES HERE vs WHAT LIVES IN ``config/feature_wiring.py``
------------------------------------------------------------
Here: the PROSE. Name, description, admin hint, and the sentence that answers "what happens
if I turn this off?". All of it is admin-editable at runtime (``PATCH /features/definitions/
{key}``) — these are only the defaults a fresh database starts with.

There: the FACTS. Which routes refuse, which UI surfaces vanish, whether the flag is wired at
all. Not editable, because editing it would not change what the server does.

``implemented`` is deliberately ABSENT from every entry below. It used to be a hand-set boolean
here and an admin-tickable checkbox in the UI — a claim about the source tree owned by people
who cannot change the source tree — and it was wrong about four flags on the day it was
written. It is now derived from ``FEATURE_WIRING`` at seed time. There is no way to state it,
so there is no way to state it wrongly.
"""
import json
from typing import Any

# A category whose flags are all wired shows no "preview" chrome. This copy is the fallback for
# any category that still holds unwired flags — none do today, and the drift guard keeps it so.
DEFAULT_PREVIEW_LABEL = "Not yet wired"
DEFAULT_PREVIEW_FOOTER = (
    "Your settings here are saved. Full behaviour for this section will be enabled in a future update."
)


def option_ids(key: str) -> frozenset[str]:
    """The set of options a ``string[]`` flag GOVERNS — as opposed to the subset an admin has
    currently allowed.

    The distinction matters at the gate. ``allowedViewModes`` is an allow-list over the layouts it
    enumerates, not a universal whitelist over every string the views API will accept: the column
    is free text, and nothing stops a future layout (or a script) using a type this registry has
    never heard of. If the gate refused anything absent from the admin's selection, the first
    person to add a new layout to the product would find it 403ing until they remembered to add it
    here too — a trap that fires far away from its cause.

    So a type the flag does not enumerate is simply none of its business.
    """
    definition = next((d for d in SEED_DEFINITIONS if d["key"] == key), None)
    if not definition or not definition.get("options"):
        return frozenset()
    return frozenset(o["id"] for o in json.loads(definition["options"]))


#: What a USER is told when a flag stops them — as opposed to ``impact_when_off``, which is what
#: an ADMIN is told before flipping it. Two audiences, two sentences, but both are flag prose, so
#: they live together rather than in the gate module: a refusal must name the thing the person was
#: trying to do and who can restore it. "feature_disabled" alone tells nobody anything they can act on.
REFUSAL_MESSAGES: dict[str, str] = {
    "enterpriseViewPolicy":
        "Publishing views to everyone is turned off for this deployment. "
        "An administrator can change this under Admin \u2192 Features.",
    "versioningEnabled":
        "Version control is turned off for this deployment. "
        "An administrator can enable it under Admin → Features.",
    "traceEnabled":
        "Lineage tracing is turned off for this deployment. "
        "An administrator can enable it under Admin → Features.",
    "editModeEnabled":
        "Editing is turned off for this deployment, so views are read-only. "
        "An administrator can enable it under Admin → Features.",
    "signupEnabled":
        "Self-registration is turned off. Ask an administrator for an invitation.",
    "inviteLinksEnabled":
        "Invite links are turned off for this deployment. "
        "An administrator can enable them under Admin → Features, or create your account directly.",
    "allowedViewModes":
        "That view type is not available in this deployment. "
        "An administrator chooses the available types under Admin → Features.",
    "graphExportEnabled":
        "Exporting graph data is turned off for this deployment. "
        "An administrator can enable it under Admin → Features.",
    "blankModelsEnabled":
        "Building a lineage model from scratch is turned off for this deployment — lineage must "
        "come from a connected data source. An administrator can enable it under Admin → Features.",
    "semanticLayerEditMode":
        "Semantic layers are read-only for this deployment. Publishing, cloning and exporting "
        "still work. An administrator can enable editing under Admin → Features.",
    "semanticLayerNonAdminEditing":
        "Only administrators can change semantic layers in this deployment. "
        "An administrator can widen this under Admin → Features.",
    "semanticLayerImportEnabled":
        "Importing semantic layers is turned off for this deployment. "
        "An administrator can enable it under Admin → Features.",
    "semanticLayerExportEnabled":
        "Exporting semantic layers is turned off for this deployment. "
        "An administrator can enable it under Admin → Features.",
    "semanticLayerAutoSuggest":
        "Suggesting a semantic layer from the graph is turned off for this deployment. "
        "You can still choose a layer yourself.",
    "semanticLayerVersionHistory":
        "Semantic layer history is hidden for this deployment. Nothing has been deleted — an "
        "administrator can show it again under Admin → Features.",
}


def _category(
    id: str, label: str, icon: str, color: str, sort_order: int, *, preview: bool = False,
) -> dict[str, Any]:
    return {
        "id": id,
        "label": label,
        "icon": icon,
        "color": color,
        "sort_order": sort_order,
        "preview": preview,
        "preview_label": DEFAULT_PREVIEW_LABEL if preview else None,
        "preview_footer": DEFAULT_PREVIEW_FOOTER if preview else None,
    }


# Every category that holds a REAL flag is now preview=False — because every flag it holds is
# wired. The empty categories (integrations, analytics, ...) keep the preview chrome: they exist
# for flags that don't exist yet, and saying so is the honest thing.
SEED_CATEGORIES: list[dict[str, Any]] = [
    _category("editing", "Editing", "Pencil", "indigo", 0),
    _category("views", "View Modes", "LayoutTemplate", "violet", 1),
    _category("auth", "Authentication", "UserPlus", "emerald", 2),
    _category("lineage", "Lineage", "GitBranch", "amber", 3),
    _category("semantic_layers", "Semantic Layers", "Layers", "indigo", 4),
    _category("governance", "Data Governance", "Shield", "rose", 5),
    _category("notifications", "Notifications", "Bell", "slate", 6),
    _category("display", "Display & UI", "Palette", "blue", 6, preview=True),
    _category("security", "Security", "Shield", "rose", 7, preview=True),
    _category("integrations", "Integrations", "Plug", "sky", 8, preview=True),
    _category("analytics", "Analytics", "BarChart3", "teal", 9),
    _category("experimental", "Experimental", "FlaskConical", "fuchsia", 10, preview=True),
    _category("performance", "Performance", "Zap", "orange", 11, preview=True),
    _category("other", "Other", "LayoutTemplate", "slate", 99, preview=True),
]


SEED_DEFINITIONS: list[dict[str, Any]] = [
    # ── Analytics ──────────────────────────────────────────────────────────────
    {
        "key": "analyticsPublicEnabled",
        "name": "Analytics for everyone",
        "description": (
            "Open the Analytics section to every signed-in person, not just administrators "
            "and auditors. Everyone sees platform-wide growth and usage; workspaces they "
            "are not a member of stay locked, and no individual's activity is ever shown."
        ),
        "impact_when_off": (
            "Analytics disappears from the sidebar for everyone except administrators, "
            "auditors and organisation admins, and the server refuses their requests. "
            "Privileged users keep the full section either way — this switch only decides "
            "whether everyone else gets the redacted view."
        ),
        "category_id": "analytics",
        "type": "boolean",
        # OFF by default, and deliberately: this widens who can see how many people
        # use the platform and how many workspaces exist. That is a disclosure
        # decision an operator should make on purpose, not inherit from a default.
        "default_value": json.dumps(False),
        "options": None,
        "help_url": None,
        "admin_hint": (
            "Turning this on is a disclosure decision. Non-privileged people see aggregate "
            "growth and usage for the whole platform, plus full detail for workspaces they "
            "belong to. Names of other workspaces, their data sources, and every per-person "
            "leaderboard stay hidden no matter who is looking."
        ),
        "sort_order": 0,
        "deprecated": False,
    },

    # ── Editing ────────────────────────────────────────────────────────────────
    {
        "key": "editModeEnabled",
        "name": "Edit mode",
        "description": (
            "Let people change the data itself — editing node properties from a view and saving "
            "those changes back to the source."
        ),
        "impact_when_off": (
            "Views become read-only. The edit controls disappear from the entity drawer and the "
            "canvas, and the server refuses any change to a node or edge. Nothing already saved "
            "is affected, and everyone can still read, filter and export."
        ),
        "category_id": "editing",
        "type": "boolean",
        "default_value": json.dumps(True),
        "options": None,
        "help_url": None,
        "admin_hint": (
            "Turn this off for a read-only deployment — a demo estate, or a production instance "
            "where lineage is owned upstream and must not be edited by hand."
        ),
        "sort_order": 0,
        "deprecated": False,
    },
    # ── View modes ─────────────────────────────────────────────────────────────
    {
        "key": "allowedViewModes",
        "name": "View modes",
        "description": (
            "Which layouts people can choose when they build a new view — Graph, Hierarchy, "
            "Context View, Layered Lineage."
        ),
        "impact_when_off": (
            "A layout you remove disappears from the View wizard and the server refuses to create "
            "a view in it. Views ALREADY built in that layout keep working and stay editable — the "
            "layout is withdrawn from new work, not deleted."
        ),
        "category_id": "views",
        "type": "string[]",
        "default_value": json.dumps(["graph", "hierarchy", "reference", "layered-lineage"]),
        "options": json.dumps([
            {"id": "graph", "label": "Graph"},
            {"id": "hierarchy", "label": "Hierarchy"},
            {"id": "reference", "label": "Context View"},
            {"id": "layered-lineage", "label": "Layered Lineage"},
        ]),
        "help_url": None,
        "admin_hint": (
            "Narrow this when you want everyone landing on the same kind of view. Clearing it "
            "entirely would leave nobody able to build anything, so at least one layout must stay on."
        ),
        "sort_order": 0,
        "deprecated": False,
    },
    # ── Authentication ─────────────────────────────────────────────────────────
    {
        "key": "signupEnabled",
        "name": "Self-registration",
        "description": "Let anyone who reaches the login page create their own account.",
        "impact_when_off": (
            "Strangers cannot create accounts: the create-account link disappears and the server "
            "refuses registration. Invited users can still register, and existing users sign in "
            "as normal. This is the door to your instance — it stays shut unless you open it."
        ),
        "category_id": "auth",
        "type": "boolean",
        "default_value": json.dumps(False),
        "options": None,
        "help_url": None,
        "admin_hint": (
            "Leave this off unless your instance is deliberately public. Invitations are the "
            "normal way in, and they keep working either way."
        ),
        "sort_order": 0,
        "deprecated": False,
    },
    {
        "key": "inviteLinksEnabled",
        "name": "Invite links",
        "description": "Let admins generate shareable signup links that carry a role and group assignments.",
        "impact_when_off": (
            "Admins can no longer create invite links, and every link already in circulation "
            "stops working immediately — including ones sent hours ago. Outstanding links stay "
            "visible so they can be reviewed and revoked, and turning this back on revives any "
            "that have not expired. Existing users sign in as normal."
        ),
        "category_id": "auth",
        "type": "boolean",
        "default_value": json.dumps(True),
        "options": None,
        "help_url": None,
        "admin_hint": (
            "This is the other door, and it is independent of self-registration: leave "
            "self-registration off and this on to run an invite-only instance. Turning this "
            "off is a kill switch — use it when a link has leaked and you want every "
            "outstanding one dead at once."
        ),
        "sort_order": 1,
        "deprecated": False,
    },
    # ── Lineage ────────────────────────────────────────────────────────────────
    {
        "key": "versioningEnabled",
        "name": "Version control",
        "description": (
            "Drafts, reviews, publishing, history and rollback for data sources — the whole "
            "change-management workflow."
        ),
        "impact_when_off": (
            "Every version-control surface is hidden and canvases become view-only: no drafts, no "
            "reviews, no publishing, no blank models. Existing history is KEPT and stays safe, "
            "background sync of already-versioned data keeps running, and nothing is deleted — "
            "turning it back on restores everything exactly as it was."
        ),
        "category_id": "lineage",
        "type": "boolean",
        "default_value": json.dumps(True),
        "options": None,
        "help_url": None,
        "admin_hint": (
            "The widest switch on this page: it withdraws editing as well as versioning, because "
            "an edit with nowhere to be reviewed is just an unaudited write."
        ),
        "sort_order": 0,
        "deprecated": False,
    },
    {
        "key": "traceEnabled",
        "name": "Lineage trace",
        "description": (
            "Follow a node's lineage upstream and downstream across the graph, from the graph and "
            "context views."
        ),
        "impact_when_off": (
            "The Trace button disappears from the toolbars and the server refuses trace requests. "
            "People can still browse and expand the graph by hand — they just can't ask it to "
            "walk the lineage for them."
        ),
        "category_id": "lineage",
        "type": "boolean",
        "default_value": json.dumps(True),
        "options": None,
        "help_url": None,
        "admin_hint": (
            "Trace can be expensive on very large graphs. Turning it off is a legitimate way to "
            "protect a struggling provider without taking the whole view away."
        ),
        "sort_order": 1,
        "deprecated": False,
    },
    # ── Data governance ────────────────────────────────────────────────────────
    {
        "key": "graphExportEnabled",
        "name": "Export graph data",
        "description": (
            "Let people download the lineage data itself — the nodes and edges of a graph — as a "
            "file they can take away."
        ),
        "impact_when_off": (
            "The export controls disappear and the server refuses both the export job and the "
            "download. Everything inside the product is unaffected: people can still read, filter "
            "and trace every graph they have access to. Files already downloaded are not recalled — "
            "this stops new ones leaving."
        ),
        "category_id": "governance",
        "type": "boolean",
        "default_value": json.dumps(True),
        "options": None,
        "help_url": None,
        "admin_hint": (
            "This is the switch that decides whether your lineage can leave the product. Note that "
            "'Export layers' only covers the SCHEMA — the shape of your estate. This one covers the "
            "data. If you are turning one off for confidentiality, you almost certainly want both."
        ),
        "sort_order": 0,
        "deprecated": False,
    },
    {
        "key": "enterpriseViewPolicy",
        "name": "Publishing views to everyone",
        "description": (
            "How far a workspace may open publishing on its own. Publishing a view makes it "
            "readable by anyone signed in, and gives them read-only access to the data source "
            "behind it."
        ),
        "impact_when_off": (
            "This is a ceiling, not a switch — it caps how open any workspace can be, and no "
            "workspace admin can go past it. 'Always require approval' overrides workspaces that "
            "have opened publishing to their members: they can still ASK, and a publisher still "
            "answers. 'Not available' withdraws the tier from new work — views already published "
            "keep working and can still be unpublished, which is never blocked."
        ),
        "category_id": "governance",
        "type": "string",
        "default_value": json.dumps("workspaces"),
        "options": json.dumps([
            {"id": "workspaces", "label": "Workspaces decide"},
            {"id": "request", "label": "Always require approval"},
            {"id": "off", "label": "Not available"},
        ]),
        "help_url": None,
        "admin_hint": (
            "Leave this on 'Workspaces decide' unless your organisation needs a rule that a "
            "workspace admin cannot opt out of. What these views expose is metadata — names, "
            "types and the lineage between them — so the default is deliberately open; tightening "
            "it everywhere is a real cost to how people share their work. If only a few sources "
            "are sensitive, mark THOSE restricted in the workspace's Views tab instead of "
            "closing the whole platform."
        ),
        "sort_order": 0,
        "deprecated": False,
    },
    {
        "key": "blankModelsEnabled",
        "name": "Build lineage from scratch",
        "description": (
            "Let people create a lineage model by hand, with no data source behind it — drawing the "
            "nodes and edges themselves."
        ),
        "impact_when_off": (
            "Lineage must come from a connected data source. The blank-model option disappears from "
            "the View wizard and the server refuses to provision one. Every blank model already "
            "built keeps working and stays editable — this only stops NEW ones."
        ),
        "category_id": "governance",
        "type": "boolean",
        "default_value": json.dumps(True),
        "options": None,
        "help_url": None,
        "admin_hint": (
            "Turn this off if your rule is that all lineage must trace back to a real system. A "
            "hand-drawn model looks exactly like a discovered one on the canvas, and once it is in "
            "the estate nobody downstream can tell which is which."
        ),
        "sort_order": 1,
        "deprecated": False,
    },
    # ── Display & UI ──────────────────────────────────────────────────────────
    {
        "key": "nodeSortingEnabled",
        "name": "Node sorting controls",
        "description": (
            "Let people choose how nodes are ordered inside a Context View layer — alphabetical, "
            "by type, by size, or a hand-arranged custom order (drag to reorder in a draft)."
        ),
        "impact_when_off": (
            "The per-layer sort menu and drag-to-reorder disappear from the canvas. Orders already "
            "saved on a view still RENDER exactly as curated — this only removes the controls for "
            "changing them, so nothing anyone published is disturbed."
        ),
        "category_id": "display",
        "type": "boolean",
        "default_value": json.dumps(True),
        "options": None,
        "help_url": None,
        "admin_hint": (
            "A kill switch for staged rollouts or locked-down estates where view curation is owned "
            "by a central team. Off = consumers see curated views verbatim and cannot re-sort."
        ),
        "sort_order": 0,
        "deprecated": False,
    },
    # ── Semantic layers ────────────────────────────────────────────────────────
    {
        "key": "semanticLayerEditMode",
        "name": "Edit semantic layers",
        "description": (
            "Create, change and delete semantic layers — the entity types, relationships and "
            "hierarchy that give a raw graph its meaning."
        ),
        "impact_when_off": (
            "Semantic layers become read-only for everyone, including admins: the editor opens but "
            "cannot save, and the server refuses create, update, delete, new-version and import — "
            "importing is editing, it just arrives as a file. Publishing, cloning and exporting "
            "still work, and every existing layer keeps doing its job."
        ),
        "category_id": "semantic_layers",
        "type": "boolean",
        "default_value": json.dumps(True),
        "options": None,
        "help_url": None,
        "admin_hint": (
            "Freeze the semantic model during a migration or an audit. Because every view resolves "
            "through these layers, a careless edit here is felt everywhere at once."
        ),
        "sort_order": 0,
        "deprecated": False,
    },
    {
        "key": "semanticLayerNonAdminEditing",
        "name": "Let non-admins edit layers",
        "description": (
            "Allow people who are not platform admins to create and change semantic layers, "
            "provided they hold the permission to manage them."
        ),
        "impact_when_off": (
            "Only platform admins can write to a semantic layer. Everyone else keeps read access "
            "and their edit controls are hidden — the server refuses their writes even if they "
            "otherwise hold the manage permission. Note this includes your workspace admins and "
            "data engineers, who can edit layers today."
        ),
        "category_id": "semantic_layers",
        "type": "boolean",
        # ON by default, deliberately — see 20260714_1400_layer_editing_default.
        #
        # The registry shipped this as `false`, but the flag was never enforced, so no deployment
        # ever CHOSE admins-only: it was a default nobody could feel. Enforcing it now at `false`
        # would have silently taken semantic-layer editing away from `workspace_admin` and
        # `workspace_data_engineer` — the second of which exists to do exactly that job. So the
        # switch starts where behaviour already is, and an admin who wants the restriction turns
        # it off on purpose. Permission (`workspace:ontology:manage`) still applies underneath;
        # this only decides whether a non-admin who HAS that permission may use it.
        "default_value": json.dumps(True),
        "options": None,
        "help_url": None,
        "admin_hint": (
            "Turn this off to make semantic layers an admin-only surface — worth doing if your "
            "layers are shared governance objects and a workspace-level change would ripple into "
            "workspaces its author doesn't own. It has no effect while 'Edit semantic layers' is "
            "off: that switch stops everyone, admins included."
        ),
        "sort_order": 1,
        "deprecated": False,
    },
    {
        "key": "semanticLayerImportEnabled",
        "name": "Import layers",
        "description": (
            "Bring a semantic layer in from an exported JSON file — as a new layer, or as a new "
            "version of an existing one."
        ),
        "impact_when_off": (
            "The Import button disappears and the server refuses uploads. Layers can still be "
            "built and edited in the UI, and exporting still works."
        ),
        "category_id": "semantic_layers",
        "type": "boolean",
        "default_value": json.dumps(True),
        "options": None,
        "help_url": None,
        "admin_hint": (
            "Turn this off to keep every change to the semantic model going through the editor, "
            "where it is reviewable, rather than arriving as a bulk file."
        ),
        "sort_order": 2,
        "deprecated": False,
    },
    {
        "key": "semanticLayerExportEnabled",
        "name": "Export layers",
        "description": (
            "Download a semantic layer as JSON — for backup, for review, or to move it to another "
            "environment."
        ),
        "impact_when_off": (
            "The Export button disappears and the server refuses the download. Reading and editing "
            "layers in the UI is unaffected."
        ),
        "category_id": "semantic_layers",
        "type": "boolean",
        "default_value": json.dumps(True),
        "options": None,
        "help_url": None,
        "admin_hint": (
            "A semantic layer describes the shape of your estate. If that shape is itself sensitive, "
            "this is the switch that stops it leaving."
        ),
        "sort_order": 3,
        "deprecated": False,
    },
    {
        "key": "semanticLayerAutoSuggest",
        "name": "Suggest from graph",
        "description": (
            "Profile a connected data source and score the existing semantic layers against it, so "
            "onboarding can recommend the layer that actually fits."
        ),
        "impact_when_off": (
            "The suggestion step disappears from the onboarding and data-source wizards, along with "
            "the match percentages, and the server refuses to score. People choose a layer from the "
            "list by hand — which, with several similarly-named layers, is genuinely harder."
        ),
        "category_id": "semantic_layers",
        "type": "boolean",
        "default_value": json.dumps(True),
        "options": None,
        "help_url": None,
        "admin_hint": (
            "Scoring reads the source's cached profile, not the source itself, so it is cheap. Turn "
            "it off only if you want layer choice to be a deliberate human decision every time."
        ),
        "sort_order": 4,
        "deprecated": False,
    },
    {
        "key": "semanticLayerVersionHistory",
        "name": "Layer history & audit",
        "description": (
            "Show every past version of a semantic layer and the audit trail of who changed what, "
            "and when."
        ),
        "impact_when_off": (
            "The history and audit tabs disappear and the server refuses to serve them. Nothing is "
            "deleted: every version is still retained, and it all comes back the moment this is "
            "switched on again."
        ),
        "category_id": "semantic_layers",
        "type": "boolean",
        "default_value": json.dumps(True),
        "options": None,
        "help_url": None,
        "admin_hint": (
            "This hides the audit trail from users — it does not stop it being recorded. If you are "
            "turning it off for compliance reasons, check that hiding is what the requirement asks for."
        ),
        "sort_order": 5,
        "deprecated": False,
    },
    # ── Notifications ──────────────────────────────────────────────────────────
    {
        "key": "announcementsEnabled",
        "name": "Announcements",
        "description": "Show announcement banners to everyone using the product.",
        "impact_when_off": (
            "Banners stop appearing for everyone — the server serves no announcements at all. Your "
            "individual announcements are HIDDEN, not deactivated: turn this back on and they "
            "return exactly as they were."
        ),
        "category_id": "notifications",
        "type": "boolean",
        "default_value": json.dumps(True),
        "options": None,
        "help_url": None,
        "admin_hint": (
            "The fastest way to silence every banner at once without going through them one by one."
        ),
        "sort_order": 0,
        "deprecated": False,
    },
    # ── Experimental ───────────────────────────────────────────────────────────
    {
        "key": "toursEnabled",
        "name": "Guided product tours",
        "description": (
            "Offer new users an interactive, in-product walkthrough of the workspace — a spotlight "
            "tour of search, navigation, personas, and help — and let anyone replay it from Help."
        ),
        "impact_when_off": (
            "No tour is ever shown or offered, and the 'Take the tour' action is hidden. Nothing "
            "else changes — the Help panel and every guide stay available. This is a preview; it "
            "ships off until you switch it on."
        ),
        "category_id": "experimental",
        "type": "boolean",
        "default_value": json.dumps(False),
        "options": None,
        "help_url": None,
        "admin_hint": (
            "Turn on to greet first-time users with a short guided tour. It's client-side only and "
            "safe to toggle at any time; users can always skip or replay it."
        ),
        "sort_order": 0,
        "deprecated": False,
    },
]
