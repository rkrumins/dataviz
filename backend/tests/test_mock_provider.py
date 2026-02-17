import pytest
import pytest_asyncio
from backend.app.providers.mock_provider import MockGraphProvider
from backend.app.models.graph import NodeQuery, PropertyFilter, FilterOperator, EntityType

@pytest.mark.asyncio
async def test_mock_provider_filtering():
    provider = MockGraphProvider()
    
    # Test Basic Filter
    nodes = await provider.get_nodes(NodeQuery(entity_types=[EntityType.DATASET]))
    assert len(nodes) > 0
    assert all(n.entity_type == EntityType.DATASET for n in nodes)
    
    # Test Property Filter (Contains) - use businessLabel which is in properties
    q = NodeQuery(
        property_filters=[
            PropertyFilter(field="businessLabel", operator=FilterOperator.CONTAINS, value="Invoice")
        ]
    )
    nodes = await provider.get_nodes(q)
    assert len(nodes) > 0
    assert "Invoice" in str(nodes[0].properties.get("businessLabel", ""))
    
    # Test Introspection
    stats = await provider.get_schema_stats()
    assert stats.total_nodes > 0
    assert len(stats.entity_type_stats) > 0
