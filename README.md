# synodic

## FalkorDB Graph Provider (Persistent Backend)

To use FalkorDB as the graph backend instead of the in-memory mock:

1. **Start FalkorDB** (Docker):
   ```bash
   docker run -d -p 6379:6379 --name falkordb falkordb/falkordb
   ```

2. **Seed the graph** (optional, for demo data):
   ```bash
   cd /path/to/synodic
   python -m backend.scripts.seed_falkordb
   ```
   Or with a smaller sample: `python -m backend.scripts.seed_falkordb --max-nodes 1000 --max-edges 2000`

3. **Run the backend** with FalkorDB:
   ```bash
   GRAPH_PROVIDER=falkordb uvicorn backend.app.main:app --port 8001 --reload
   ```

### Environment Variables

| Variable | Default | Description |
|----------|---------|--------------|
| `GRAPH_PROVIDER` | `mock` | `mock` or `falkordb` |
| `FALKORDB_HOST` | `localhost` | FalkorDB/Redis host |
| `FALKORDB_PORT` | `6379` | FalkorDB/Redis port |
| `FALKORDB_GRAPH_NAME` | `nexus` | Graph name in FalkorDB |
| `FALKORDB_SEED_FILE` | (none) | Optional JSON path to seed on empty graph |