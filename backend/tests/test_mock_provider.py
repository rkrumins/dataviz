import pytest
import pytest_asyncio
from backend.app.providers.mock_provider import MockGraphProvider
from backend.app.models.graph import NodeQuery, PropertyFilter, FilterOperator, EntityType

@pytest.mark.asyncio
async def test_mock_provider_filtering():
    provider = MockGraphProvider()
    
    # Test Basic Filter
    nodes = await provider.getNodes(NodeQuery(entity_types=[EntityType.DATASET]))
    assert len(nodes) > 0
    assert all(n.entity_type == EntityType.DATASET for n in nodes)
    
    # Test Property Filter (Contains)
    q = NodeQuery(
        property_filters=[
            PropertyFilter(field="displayName", operator=FilterOperator.CONTAINS, value="Table")
        ]
    )
    nodes = await provider.get_nodes(q)
    assert len(nodes) > 0
    assert "Table" in nodes[0].display_name
    
    # Test Introspection
    stats = await provider.get_schema_stats()
    assert stats.totalNodes > 0
    assert len(stats.entityTypeStats) > 0
