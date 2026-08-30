"""
FalkorDB graph provider - persists graph data in FalkorDB and loads it via the application.
Implements GraphDataProvider interface using FalkorDB async client and Cypher queries.
"""

from backend.app.providers.base import GraphDataProvider

from backend.app.providers.falkordb.aggregation import AggregationMixin
from backend.app.providers.falkordb.trace import TraceMixin
from backend.app.providers.falkordb.closure import ClosureMixin
from backend.app.providers.falkordb.connection import ConnectionMixin
from backend.app.providers.falkordb.schema import SchemaMixin
from backend.app.providers.falkordb.ontology import OntologyMixin
from backend.app.providers.falkordb.caches import CacheMixin
from backend.app.providers.falkordb.ancestors import AncestorMixin
from backend.app.providers.falkordb.reads import ReadMixin
from backend.app.providers.falkordb.browse import BrowseMixin
from backend.app.providers.falkordb.lineage_simple import SimpleLineageMixin
from backend.app.providers.falkordb.drill import DrillMixin
from backend.app.providers.falkordb.stats import StatsMixin
from backend.app.providers.falkordb.navigation import NavigationMixin
from backend.app.providers.falkordb.writes import WriteMixin


class FalkorDBProvider(ConnectionMixin, SchemaMixin, OntologyMixin, CacheMixin, AncestorMixin, ReadMixin, BrowseMixin, SimpleLineageMixin, DrillMixin, StatsMixin, NavigationMixin, WriteMixin, AggregationMixin, TraceMixin, ClosureMixin, GraphDataProvider):
    """
    Graph data provider backed by FalkorDB.
    Schema: nodes have label = entityType, properties include urn, displayName, etc.
    Edges use relationship type = edgeType (CONTAINS, PRODUCES, etc.).
    """
