"""Cypher expressions for a source's node-identity mapping.

The platform keys nodes on ``urn`` and names them from ``displayName``. An
onboarded third-party graph keys nodes by ``id`` and names them under ``title``.
``backend.app.services.node_identity`` decides WHICH properties a given source
uses; this module turns that decision into Cypher, in one place, quoted once.

Two mechanisms carry the mapping, and they are not alternatives:

* the **conformance stamp** (``FalkorDBProvider.stamp_identity_urns``) copies the
  mapped properties onto ``urn`` / ``displayName`` at aggregation start, which is
  what makes the urn-keyed WRITE, index and traversal stack work — a ``MERGE``
  cannot key on a ``coalesce`` expression, so nothing else can fix writes;
* these expressions resolve identity at READ time, which is what covers the
  cases the stamp can't reach: a read-only source, a dedicated projection, a
  node added since the last run, or simply a mapping declared five minutes ago
  that nobody has re-aggregated yet.

Both default to the plain canonical property, so a conforming graph emits
exactly the Cypher it always did.
"""
from __future__ import annotations

from typing import Optional

DEFAULT_IDENTITY_PROPERTY = "urn"
DEFAULT_DISPLAY_NAME_PROPERTY = "displayName"


def quote_property(name: str) -> str:
    """Backtick-quote a property name for Cypher.

    Embedded backticks are STRIPPED, not escaped. Doubling is the spec's escape
    and would preserve a pathological name faithfully, but it makes the quoting
    correct only as far as the server's parser agrees — and the value here comes
    straight from an operator-typed field. Stripping cannot produce a string
    that closes the quote early under any parser, and no real graph has a
    property whose name contains a backtick.
    """
    return "`" + str(name).replace("`", "") + "`"


def node_identity_expr(
    identity_property: Optional[str], var: str = "n",
) -> str:
    """Cypher for a node's canonical identity.

    ``n.`urn``` when the source conforms (the overwhelmingly common case, and a
    cheap short-circuit), else ``coalesce(n.`urn`, n.`id`)`` — the platform's own
    property still wins per node, so a partially-stamped graph resolves
    consistently whichever half a node is in.
    """
    prop = (identity_property or DEFAULT_IDENTITY_PROPERTY).strip()
    canonical = f"{var}.{quote_property(DEFAULT_IDENTITY_PROPERTY)}"
    if not prop or prop == DEFAULT_IDENTITY_PROPERTY:
        return canonical
    return f"coalesce({canonical}, {var}.{quote_property(prop)})"


def node_display_name_expr(
    name_property: Optional[str], var: str = "n",
) -> str:
    """Cypher for a node's human label.

    Symmetric to :func:`node_identity_expr`: ``displayName`` wins when present,
    the source's mapped property fills in otherwise. Note the asymmetry in what
    "default" means — the identity's canonical property and its default SOURCE
    are both ``urn``, but a display name is canonically ``displayName`` while
    the default source property is ``name``, so passing ``"name"`` still
    produces a real coalesce rather than short-circuiting.
    """
    prop = (name_property or "").strip()
    canonical = f"{var}.{quote_property(DEFAULT_DISPLAY_NAME_PROPERTY)}"
    if not prop or prop == DEFAULT_DISPLAY_NAME_PROPERTY:
        return canonical
    return f"coalesce({canonical}, {var}.{quote_property(prop)})"
