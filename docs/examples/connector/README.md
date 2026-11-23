# Reference connector

`connector.py` sends a source system's catalog into a data source's graph through the HTTP API
alone. It can also send any NDJSON, CSV or TSV file you already have, gigabytes included. It is
what [Building a Connector](../../CONNECTOR_GUIDE.md) describes, in about 300 lines.

- **`source.json`**: a warehouse's tables, their columns, the lineage between tables, and a table
  it dropped.
- **`to_records`** maps it to import records (format v1). Each node is pointed at by a urn of the
  source's own (`urn:acme-warehouse:table:…`), so every run finds the same nodes. `write_ndjson`
  streams them to a file on disk.
- **`Graph`** makes the API calls:
  - **`upload`** sends the file in resumable parts, 4 at a time, read from disk. A run that stopped
    is resumed by the next one, which sends only the parts the server lacks. Progress is kept in a
    state file beside the file, keyed on its sha256.
  - **`start`** imports the upload into a draft. With `--publish` the import publishes itself
    (`autoPublish`) once every row is applied.
  - **`follow`** polls a job until it finishes, waiting longer between polls as it goes. A large
    import runs for hours.
  - **`published`** follows the publish to its end. If the import never wrote how its publish went
    (its worker stopped in between), it publishes the draft itself.
  - **`check`** is the dry run, on the file's first rows.
- **`Api`** asks again whenever an answer says to: a 429 or 503 after its `Retry-After`, another
  5xx or a dropped connection after a growing pause.

```bash
pip install httpx
export SYNODIC_URL=https://synodic.example.com SYNODIC_TOKEN=nxsat_…    # a service account's key
python connector.py source.json --workspace ws_… --graph graph_… --check       # a dry run only
python connector.py source.json --workspace ws_… --graph graph_… --publish     # import and publish
python connector.py --file export.csv --workspace ws_… --graph graph_… --publish
```

Without `--publish`, the import lands in a draft for someone to review and publish. With it, the
printed `publish.state` says how the publish ended: `published`; `unchanged`, when there was nothing
to publish (a success); `skipped`, with `publish.reason` saying why; or `failed`. The run exits
non-zero when the import fails, or when it couldn't publish itself. Run it again and nothing
changes.

A full snapshot each night, which deletes what the source no longer has:

```bash
python connector.py --file nightly.ndjson --workspace ws_… --graph graph_… --replace --identifier urn --publish
```

| Option | Sends | Does |
|---|---|---|
| `--replace` | `reconcileMode=replace` | Deletes what the file leaves out; without it, an upsert writes only what the file names |
| `--identifier entity_id\|urn\|prop.<name>\|prop.<name>,urn` | `identifier` | What the file's rows find their items by: `prop.<name>,urn` finds a row without the property by its urn. Left out, the graph's default |
| `--replace-scope keyed` | `replaceScope` | With `--replace` and a property identifier: deletes only what holds the property, leaving what the app or other sources made |
| `--allow-mass-delete` | `allowMassDelete=true` | Lets a replace delete past the replace guard |
| `--branch br_…` | `branchId` | Imports into that open draft, beside what it holds. With `--publish`, the connector publishes the draft once the import is in (an import into a draft doesn't publish itself) |
| `--max-refused-rows N` | `maxRefusedRows` | Goes on without up to N refused rows (a count, a share such as `1%`, or `-1` for any); without it, a refused row holds a replace and the import's own publish. The run's output names each refused row, where it is, and why |

A replace the guard refused fails with `import failed (mass_delete_blocked): …`, and its rows wait
on the draft. If the deletes are meant, send the file again into that draft:
`--replace --allow-mass-delete --branch <its branchId> --publish`. An upload in progress is kept per
file and options, so a run with other options starts its own.

`backend/tests/test_connector_example.py` keeps it honest. Every record must pass the record
contract, and the same source must give the same file. The test's server answers as the API does:
parts, resume, `Retry-After`, the publish and its fallback. Every call the connector makes must be
one an API key may make (`api_key_surface`).
