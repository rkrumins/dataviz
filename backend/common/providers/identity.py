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

from typing import Callable, List, Optional

DEFAULT_IDENTITY_PROPERTY = "urn"
DEFAULT_DISPLAY_NAME_PROPERTY = "displayName"
#: Where a node with no displayName is named from, after the source's own name
#: property — the read path's fallbacks (``falkordb_provider._node_from_props``).
NAME_FALLBACK_PROPERTIES = ("name", "title", "label")


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


def node_name_columns(name_property: Optional[str]) -> List[str]:
    """Where the name a node is SHOWN by is read from, first to last:
    displayName, the source's name property, then name, title, label — the
    read path's order, so the canvas, ranking and search agree on a name."""
    columns = [DEFAULT_DISPLAY_NAME_PROPERTY]
    for key in ((name_property or "").strip(), *NAME_FALLBACK_PROPERTIES):
        if key and key not in columns:
            columns.append(key)
    return columns


def node_shown_name_expr(name_property: Optional[str], var: str = "n", *,
                         fallback_only: bool = False) -> str:
    """Cypher for the name a node is shown by: the first non-empty text of
    :func:`node_name_columns`, as the read path's ``or`` chain takes it; null
    when there is none. ``fallback_only`` leaves displayName out — the name of
    a node that has none."""
    columns = node_name_columns(name_property)[1 if fallback_only else 0:]
    parts = ", ".join(_text_if_any(f"{var}.{quote_property(c)}") for c in columns)
    return f"coalesce({parts})"


def node_name_match(name_property: Optional[str], test: Callable[[str], str],
                    var: str = "n") -> str:
    """``test`` — a column expression to a condition — applied to the name a
    node is shown by: its displayName, or for a node without one, its
    fallback (:func:`node_shown_name_expr`). A graph this app did not write
    keeps its names under ``name`` and has no displayName, so a search that
    read displayName alone found none of them.

    displayName is compared on its own, as it always was, and the fallback
    only for a node without one: FalkorDB short-circuits a WHERE, so a node
    that has a displayName costs what it did. Not parenthesised — the caller
    ORs it among its own conditions."""
    shown = f"{var}.{DEFAULT_DISPLAY_NAME_PROPERTY}"
    fallback = node_shown_name_expr(name_property, var, fallback_only=True)
    return f"{test(shown)} OR (({shown} IS NULL OR {shown} = '') AND {test(fallback)})"


def _text_if_any(col: str) -> str:
    return f"CASE WHEN typeOf({col}) = 'String' AND {col} <> '' THEN {col} END"
