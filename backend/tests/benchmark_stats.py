import asyncio
import time
import os
import sys

# Add backend to path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '../..')))

from backend.app.providers.falkordb_provider import FalkorDBProvider

async def benchmark():
    print("Initializing FalkorDBProvider...")
    provider = FalkorDBProvider(
        host=os.getenv("FALKORDB_HOST", "localhost"),
        port=int(os.getenv("FALKORDB_PORT", "6379")),
        graph_name=os.getenv("FALKORDB_GRAPH_NAME", "nexus")
    )
    
    # Warmup
    print("Warming up...")
    try:
        await provider.get_stats()
    except Exception as e:
        print(f"Connection failed: {e}")
        return

    print("\n--- Benchmarking get_stats ---")
    start_time = time.time()
    stats = await provider.get_stats()
    end_time = time.time()
    print(f"Time taken: {end_time - start_time:.4f} seconds")
    print(f"Node count: {stats.get('nodeCount')}")
    print(f"Edge count: {stats.get('edgeCount')}")

    print("\n--- Benchmarking get_schema_stats ---")
    start_time = time.time()
    schema_stats = await provider.get_schema_stats()
    end_time = time.time()
    print(f"Time taken: {end_time - start_time:.4f} seconds")
    print(f"Total Nodes: {schema_stats.total_nodes}")
    print(f"Total Edges: {schema_stats.total_edges}")
    print(f"Entity Types: {len(schema_stats.entity_type_stats)}")

if __name__ == "__main__":
    asyncio.run(benchmark())
