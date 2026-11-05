# Reference connector

`connector.py` sends a source system's catalog into a data source's graph through the HTTP API
alone. It is what [Building a Connector](../../CONNECTOR_GUIDE.md) describes, in about 150 lines.

- **`source.json`**: a warehouse's tables, their columns, the lineage between tables, and a table
  it dropped.
- **`to_records`**: maps it to import records (format v1). Each node is pointed at by a urn of
  the source's own (`urn:acme-warehouse:table:…`), so every run finds the same nodes.
- **`Graph`**: the API calls.
  - `validate`: the dry run;
  - `start_import`: one request, or resumable parts past 100 MB, sending only the parts the server
    lacks, under an idempotency key drawn from the file;
  - `wait`: polls the job until it finishes.

```bash
pip install httpx
export SYNODIC_URL=https://synodic.example.com SYNODIC_TOKEN=nxsat_…   # a service account's key
python connector.py source.json --workspace ws_… --graph gv_… --check  # check only
python connector.py source.json --workspace ws_… --graph gv_…          # check, then import
```

The import lands in a draft; publish it, or open a merge request for review. Run it again and
nothing changes.

`backend/tests/test_connector_example.py` keeps it honest: every record passes the record
contract, the same source gives the same file, and its calls match the API.
