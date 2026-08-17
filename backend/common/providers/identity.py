"""Cypher for a source's property mapping — one place, quoted once.

The platform keys nodes on ``urn``, names them from ``displayName``, and reads
``qualifiedName`` / ``description`` / ``tags`` / ``entityType`` alongside. An
onboarded third-party graph uses its own names for all of those.
``backend.app.services.node_identity`` decides WHICH properties a given source
uses; this module turns that decision into Cypher.

**Two kinds of property, and the line between them is the whole design.**

*Source-owned* properties describe data the graph already had — identity, the
human name, a qualified name, a description, tags. Those are MAPPED: the source
named them, so the platform reads whatever the source calls them.

*Platform-owned* properties are ones the platform INVENTS — ``level`` (hierarchy
depth), ``layerAssignment``, ``childCount``, ``searchableText``, ``entityId``,
plus everything on an ``:AGGREGATED`` edge. Mapping those is meaningless: a
foreign graph has no opinion about what its nodes' hierarchy depth is called
because it does not have one. They are always written and read under their
literal names. The Neo4j adapter drew the same line for the same reason
(``neo4j_provider.ensure_indices``: *"`level` … Not subject to schema mapping —
we own this property"*).

Everything here defaults to the plain canonical property, so a conforming graph
emits exactly the Cypher it always did.
"""
from __future__ import annotations

from typing import Any, Optional

DEFAULT_IDENTITY_PROPERTY = "urn"
DEFAULT_DISPLAY_NAME_PROPERTY = "displayName"

#: Properties the PLATFORM writes and owns. Never mapped — see the module
#: docstring. Kept here rather than inferred from ``SchemaMapping`` because that
#: class exposes some of these as mappable for the Neo4j adapter's benefit, and
#: the distinction that matters to us is "did the source's own data supply this
#: value", not "is there a config field for it".
PLATFORM_OWNED_PROPERTIES: frozenset = frozenset({
    "level", "layerAssignment", "childCount", "searchableText",
    "entityId", "propertiesRaw", "levelDigest",
    # :AGGREGATED edge properties.
    "aggKey", "weight", "sourceLevel", "targetLevel",
    "sourceDepth", "targetDepth", "latestUpdate", "sourceEdgeTypes",
    # The conformance stamp's own provenance markers.
    "urnSource", "nameSource",
})


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
    """Cypher for a node's canonical identity, TOLERANT of a mixed graph.

    ``n.`urn``` when the source conforms (the overwhelmingly common case, and a
    cheap short-circuit), else ``coalesce(n.`urn`, n.`id`)`` — the platform's own
    property still wins per node, so a graph the conformance stamp has only
    half-reached resolves consistently whichever half a node is in.

    Prefer :func:`node_identity_prop` wherever the expression has to be
    INDEX-SEEKABLE (a lookup predicate, an ``ORDER BY``): a ``coalesce`` cannot
    use an index, and on a large graph that is the difference between a seek and
    a full label scan.
    """
    prop = (identity_property or DEFAULT_IDENTITY_PROPERTY).strip()
    canonical = f"{var}.{quote_property(DEFAULT_IDENTITY_PROPERTY)}"
    if not prop or prop == DEFAULT_IDENTITY_PROPERTY:
        return canonical
    return f"coalesce({canonical}, {var}.{quote_property(prop)})"


def node_identity_prop(
    identity_property: Optional[str], var: str = "n",
) -> str:
    """Cypher for a node's identity as a BARE property access — no coalesce.

    Correct for any source whose mapping is authoritative, which is every mapped
    source: the conformance stamp COPIES the mapped property onto ``urn``, it
    never moves it, so the mapped property is present whether or not a stamp has
    run. The one case this does not cover is a genuinely mixed graph where some
    nodes carry only ``urn`` and never carried the mapped property — those need
    :func:`node_identity_expr`.

    This is the form to use in a WHERE predicate, a MERGE key or an ORDER BY,
    because it can use an index.
    """
    prop = (identity_property or DEFAULT_IDENTITY_PROPERTY).strip()
    return f"{var}.{quote_property(prop or DEFAULT_IDENTITY_PROPERTY)}"


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


class MappedCypher:
    """Builds property references for ONE source, from its resolved mapping.

    Bound to a ``SchemaMapping`` (``backend.graph.adapters.schema_mapping``),
    which already carries every source-owned field and already knows how to
    layer a provider default under a data-source override. This class adds the
    Cypher rendering and the platform-owned exemption on top; it deliberately
    owns no configuration of its own.

    ``None`` is a valid mapping and means "this source conforms" — every method
    then returns the canonical property, so an unmapped source's Cypher is
    byte-for-byte what it was before any of this existed.
    """

    __slots__ = ("_mapping",)

    def __init__(self, mapping: Any = None):
        self._mapping = mapping

    # ── source-owned ──────────────────────────────────────────────────

    @property
    def identity_property(self) -> str:
        """The raw (unquoted) property this source keys nodes by."""
        return (
            getattr(self._mapping, "identity_field", None)
            or DEFAULT_IDENTITY_PROPERTY
        )

    @property
    def name_property(self) -> str:
        """The raw (unquoted) property this source's human name lives in."""
        return (
            getattr(self._mapping, "display_name_field", None)
            or DEFAULT_DISPLAY_NAME_PROPERTY
        )

    def ident(self, var: str = "n") -> str:
        """Identity, tolerant of a half-stamped graph. See
        :func:`node_identity_expr`."""
        return node_identity_expr(self.identity_property, var)

    def ident_prop(self, var: str = "n") -> str:
        """Identity as a bare, index-seekable property access. See
        :func:`node_identity_prop`."""
        return node_identity_prop(self.identity_property, var)

    def name(self, var: str = "n") -> str:
        """Display name, tolerant of a half-stamped graph."""
        return node_display_name_expr(self.name_property, var)

    def field(self, canonical: str, var: str = "n") -> str:
        """Any canonical field, mapped when the source owns it.

        A platform-owned name passes through untouched — that is the point of
        the exemption, not an oversight, so callers can route EVERY property
        reference through here without having to remember which is which.
        """
        return f"{var}.{quote_property(self.property_for(canonical))}"

    def property_for(self, canonical: str) -> str:
        """The raw property name this source uses for ``canonical``."""
        if canonical in PLATFORM_OWNED_PROPERTIES or self._mapping is None:
            return canonical
        resolver = getattr(self._mapping, "cypher_field", None)
        if resolver is None:
            return canonical
        return resolver(canonical) or canonical

    # ── introspection ─────────────────────────────────────────────────

    @property
    def is_identity_mapped(self) -> bool:
        return self.identity_property != DEFAULT_IDENTITY_PROPERTY

    @property
    def is_conforming(self) -> bool:
        """True when nothing is mapped, so every reference is canonical and the
        caller can skip mapping work entirely."""
        if self._mapping is None:
            return True
        is_default = getattr(self._mapping, "is_default", None)
        return bool(is_default) if is_default is not None else False

    def __repr__(self) -> str:
        if self.is_conforming:
            return "<MappedCypher conforming>"
        return (
            f"<MappedCypher identity={self.identity_property!r} "
            f"name={self.name_property!r}>"
        )
