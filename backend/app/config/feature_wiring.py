"""What each feature flag ACTUALLY does — declared in code, because only code can know.

The registry had a column called ``implemented``, and an admin could tick it. That is a
checkbox asserting a fact about the source tree, owned by someone who cannot change the
source tree. It drifted immediately: it claimed ``signupEnabled`` and ``traceEnabled`` were
unwired (both are), while eight of the twelve toggles it presented as real did nothing at
all — no server gate, no UI effect. An admin could turn "Import" off and users would go on
importing. A switch that reports its own state incorrectly is worse than no switch, because
it is *trusted*.

So the facts move here, to the one place that cannot lie about the code: the code.

    THE SPLIT
    ---------
    CODE owns the FACTS   — where a flag is enforced, what disappears, whether it is wired
                            at all. Not editable from the admin UI, because editing it would
                            not change what the server does.
    THE DB owns the PROSE — name, description, admin hint, the impact sentence. An admin may
                            reword any of it; `feature_definitions` stays the content store.

``tests/test_feature_wiring.py`` holds the two halves together: every flag that declares a
server gate must have its key read somewhere in ``backend/app``, and every flag that declares
a UI surface must have its key read somewhere in ``frontend/src``. Delete a gate and the test
fails; add a flag and forget to wire it and the test fails. The registry cannot go back to
lying without someone deliberately editing this file to say so.

POSTURE is the other thing only code can decide: what to assume when the flag CANNOT be read
(database down, row missing). A `capability` flag fails OPEN — a database hiccup must never
black out whole product areas. A `security` flag fails CLOSED — if we cannot tell whether the
admin left the door open, we assume they wanted it shut, because the cost of guessing wrong is
unbounded in one direction and merely annoying in the other.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

Posture = Literal["capability", "security"]

#: Where a flag is in its life. This is the answer to two questions that had none:
#:
#:   "How do I add a flag for a feature I am still BUILDING?"
#:       `experimental`. The drift guard's both-halves rule is relaxed (the halves don't exist
#:       yet), but the flag must default OFF — shipping a half-built feature switched on is how a
#:       preview becomes an incident. The page badges it so an admin knows what they're turning on.
#:
#:   "What happens when a feature stops being optional?"
#:       `deprecated`. The flag is on its way out: you remove the gates from the code, and the
#:       guard then enforces the OPPOSITE of the usual rule — the key must appear NOWHERE in
#:       either tree. Then you delete the definition and the stored value is cleaned up.
#:
#: Without this, a flag has only two states — "exists" and "gone" — and the space between them is
#: where dead switches accumulate. Every flag on this page is a permanent obligation until somebody
#: deliberately ends it, and nothing in the system was asking anybody to.
Stage = Literal["experimental", "active", "deprecated"]


@dataclass(frozen=True)
class FeatureWiring:
    """The code-owned truth about one flag."""

    key: str

    #: Fail-open (capability) or fail-closed (security) when the flag can't be resolved.
    posture: Posture

    #: Where it is in its life. See `Stage`. Defaults to the only state worth shipping.
    stage: Stage = "active"

    #: Where the SERVER refuses when this is off. Empty = no server enforcement, which means
    #: the flag is cosmetic and anyone who knows the URL still has the feature.
    server_gates: tuple[str, ...] = ()

    #: What the CLIENT stops offering when this is off. Empty = the UI still shows the
    #: affordance and the user earns a 403 by clicking it.
    ui_surfaces: tuple[str, ...] = ()

    #: What keeps working when it's off — the reassurance half. Turning a feature off makes it
    #: unavailable, not destructive: nothing is deleted, reads stay open.
    still_allowed: tuple[str, ...] = ()

    #: Flags that must be ON for this one to mean anything.
    depends_on: tuple[str, ...] = field(default_factory=tuple)

    @property
    def fail_safe_default(self) -> bool:
        """What to assume when the flag cannot be read. See the module docstring."""
        return self.posture == "capability"

    @property
    def enforced_server_side(self) -> bool:
        """False means the toggle is decoration: the endpoint is still reachable."""
        return bool(self.server_gates)

    @property
    def must_default_on(self) -> bool:
        """The policy, in code: a working feature is AVAILABLE unless an admin says otherwise.

        Users cannot ask for a capability they have never seen, so a capability flag that ships OFF
        is a feature nobody discovers and nobody requests — it just quietly isn't part of the
        product. Defaulting them ON is the difference between "an admin may restrict this" and "an
        admin must go and find this".

        SECURITY flags are exempt, and `signupEnabled` is why the exemption exists: ON there does
        not mean "users can see a feature", it means any stranger who reaches the login page can
        create an account. A blanket default-ON rule would have opened the door on every fresh
        deployment in the name of discoverability.

        EXPERIMENTAL flags are exempt in the other direction: they must default OFF, because the
        feature is not finished and switching an unfinished thing on for everyone is not a preview,
        it's an incident.
        """
        return self.stage == "active" and self.posture == "capability"

    @property
    def wired(self) -> bool:
        """Does this flag change anything at all? This is what ``implemented`` always meant —
        it was simply stored where it could be wrong."""
        return bool(self.server_gates) or bool(self.ui_surfaces)


FEATURE_WIRING: dict[str, FeatureWiring] = {
    # ── Lineage ────────────────────────────────────────────────────────────────
    "versioningEnabled": FeatureWiring(
        key="versioningEnabled",
        posture="capability",
        server_gates=(
            "versioning_gate.py — every /graph write (drafts, commits, merges, reverts)",
            "versioned_write_provider.py — backstop on the write-through path",
        ),
        ui_surfaces=(
            "Canvas edit mode, drafts, reviews and history",
            "Import/export menu on the context view",
            "Blank-model creation",
            "Version history timeline and PR drawer",
        ),
        still_allowed=(
            "Reading every canvas and view",
            "Existing history is kept — nothing is deleted",
            "Background sync of already-versioned data keeps running",
        ),
    ),
    "traceEnabled": FeatureWiring(
        key="traceEnabled",
        posture="capability",
        server_gates=("POST /graph/trace — upstream/downstream lineage traversal",),
        ui_surfaces=("Trace button in the graph and context view toolbars",),
        still_allowed=("Browsing and expanding the graph by hand",),
    ),
    # ── Editing ────────────────────────────────────────────────────────────────
    "editModeEnabled": FeatureWiring(
        key="editModeEnabled",
        posture="capability",
        server_gates=("Graph mutation routes — node/edge create, update and delete",),
        ui_surfaces=(
            "Edit controls in the entity drawer",
            "Node/edge editing on the canvas",
        ),
        still_allowed=("Reading every view", "Exporting data"),
    ),
    # ── View modes ─────────────────────────────────────────────────────────────
    "allowedViewModes": FeatureWiring(
        key="allowedViewModes",
        posture="capability",
        server_gates=("POST/PUT /views — refuses a view whose type is not in the list",),
        ui_surfaces=("Layout picker in the View wizard",),
        still_allowed=(
            "Views already built in a removed layout keep working — the layout is "
            "withdrawn from NEW views, not deleted",
        ),
    ),
    # ── Authentication ─────────────────────────────────────────────────────────
    "signupEnabled": FeatureWiring(
        key="signupEnabled",
        posture="security",
        server_gates=("POST /auth/register — refuses strangers without an invite",),
        ui_surfaces=("Create-account link on the login page",),
        still_allowed=("Invited users can always register", "Everyone can sign in"),
    ),
    # ── Notifications ──────────────────────────────────────────────────────────
    "announcementsEnabled": FeatureWiring(
        key="announcementsEnabled",
        posture="capability",
        server_gates=("GET /announcements — serves an empty list when off",),
        # Deliberately no UI surface: the server withholds the content, so there is nothing
        # for the client to hide. Enforcing it twice would only add a way to disagree.
        ui_surfaces=(),
        still_allowed=(
            "Announcements are hidden, not deactivated — turning this back on restores them",
        ),
    ),
    # ── Data governance ────────────────────────────────────────────────────────
    "graphExportEnabled": FeatureWiring(
        key="graphExportEnabled",
        posture="capability",
        server_gates=(
            "POST /graphs/{id}/exports — start an export job",
            "GET /graphs/{id}/exports/{job}/download — take the file",
        ),
        ui_surfaces=("Export controls on the canvas and the context-view menu",),
        still_allowed=(
            "Reading, filtering and tracing every graph in the product",
            "Exports already downloaded are not recalled — this stops NEW ones",
        ),
    ),
    "blankModelsEnabled": FeatureWiring(
        key="blankModelsEnabled",
        posture="capability",
        server_gates=("POST /blank-graphs — provision a lineage model with no data source",),
        ui_surfaces=(
            "Blank-model option in the View wizard",
            "'Start from scratch' on the canvas empty state",
        ),
        still_allowed=(
            "Every blank model already built keeps working and stays editable",
            "Building views on top of real data sources",
        ),
        # It provisions a versioned graph, so version control has to be on for it to mean anything.
        depends_on=("versioningEnabled",),
    ),
    # ── Semantic layers ────────────────────────────────────────────────────────
    "semanticLayerEditMode": FeatureWiring(
        key="semanticLayerEditMode",
        posture="capability",
        server_gates=(
            "POST /admin/ontologies — create",
            "PUT /admin/ontologies/{id} — update",
            "DELETE /admin/ontologies/{id} — delete",
            "POST /admin/ontologies/{id}/restore",
            "POST /admin/ontologies/{id}/new-version",
            "POST /admin/ontologies/import and /{id}/import — importing IS editing",
        ),
        ui_surfaces=(
            "Create / Edit / Delete controls on the semantic layer pages",
            "The layer editor is read-only",
        ),
        still_allowed=("Publishing", "Cloning", "Exporting", "Reading every layer"),
    ),
    "semanticLayerImportEnabled": FeatureWiring(
        key="semanticLayerImportEnabled",
        posture="capability",
        server_gates=(
            "POST /admin/ontologies/import — import as a new layer",
            "POST /admin/ontologies/{id}/import — import into an existing layer",
        ),
        ui_surfaces=("Import button on the semantic layer pages",),
        still_allowed=("Editing layers in the UI editor", "Exporting"),
        # An import rewrites a layer's content, so it is a form of editing: it also answers to
        # the edit gate. Without this, "semantic layers are read-only" would be false the moment
        # someone uploaded a file — the exact hole these flags exist to close.
        depends_on=("semanticLayerEditMode",),
    ),
    "semanticLayerExportEnabled": FeatureWiring(
        key="semanticLayerExportEnabled",
        posture="capability",
        server_gates=("GET /admin/ontologies/{id}/export — download the definition as JSON",),
        ui_surfaces=("Export button on the semantic layer pages",),
        still_allowed=("Reading and editing layers in the UI",),
    ),
    "semanticLayerAutoSuggest": FeatureWiring(
        key="semanticLayerAutoSuggest",
        posture="capability",
        server_gates=("POST /admin/ontologies/suggest — score layers against a graph",),
        ui_surfaces=(
            "Suggest-from-graph step in the onboarding and data-source wizards",
            "Match percentages when choosing a layer",
        ),
        still_allowed=("Choosing a layer by hand", "Building a layer from scratch"),
    ),
    "semanticLayerVersionHistory": FeatureWiring(
        key="semanticLayerVersionHistory",
        posture="capability",
        server_gates=(
            "GET /admin/ontologies/{id}/versions — the version list",
            "GET /admin/ontologies/{id}/audit — the audit trail",
        ),
        ui_surfaces=("History and audit tabs on a semantic layer",),
        still_allowed=(
            "History is hidden, not deleted — every version is retained and returns when "
            "this is switched back on",
        ),
    ),
    "semanticLayerNonAdminEditing": FeatureWiring(
        key="semanticLayerNonAdminEditing",
        # SECURITY: this widens who may write. If we cannot read it, we must assume the
        # admin's intent was the narrower world — admins only.
        posture="security",
        server_gates=(
            "Every semantic-layer write (create, update, delete, restore, new-version, "
            "publish, clone, import) — a non-admin is refused unless this is on",
        ),
        ui_surfaces=("Edit controls are hidden from non-admins on the semantic layer pages",),
        still_allowed=("Admins can always manage layers", "Everyone can read layers"),
        depends_on=("semanticLayerEditMode",),
    ),
}


def wiring_for(key: str) -> FeatureWiring | None:
    return FEATURE_WIRING.get(key)


def wiring_payload(key: str) -> dict:
    """The facts, in the shape the API and the admin page speak (camelCase).

    ONE function, because there are two callers and they must not disagree: the live API
    (`feature_registry_repo._row_to_definition`) and the offline fallback the frontend bundles
    (`scripts/export_features_fallback.py`). The exporter had its own copy of this projection,
    it was never updated, and so the bundled fallback went on hard-coding `implemented: false`
    for every flag — which is how the page can render "12 switches are not enforced" while the
    server enforces all twelve. Same bug as the column, one layer out.
    """
    w = FEATURE_WIRING.get(key)
    return {
        "stage": w.stage if w else "active",
        "implemented": bool(w.wired) if w else False,
        "enforcedServerSide": bool(w.enforced_server_side) if w else False,
        "posture": w.posture if w else "capability",
        "serverGates": list(w.server_gates) if w else [],
        "uiSurfaces": list(w.ui_surfaces) if w else [],
        "stillAllowed": list(w.still_allowed) if w else [],
        "dependsOn": list(w.depends_on) if w else [],
    }


def fail_safe_default(key: str) -> bool:
    """The `default=` every gate for `key` must pass. One place, so two gates on the same flag
    cannot disagree about which way it fails."""
    w = FEATURE_WIRING.get(key)
    return w.fail_safe_default if w else True
