# FalkorDB / Redis topology harnesses

Compose files to stand up FalkorDB in each supported topology so the topology
integration tests (`backend/tests/integration/test_topologies.py`) can exercise
the provider + aggregation + insights end-to-end across **standalone /
Sentinel / Cluster × auth × TLS**.

These are validation harnesses, not production manifests.

## TLS certs

```bash
./deploy/topologies/gen-certs.sh        # writes certs/{ca,server}.{crt,key}
```

## Standalone + auth + TLS

```bash
docker compose -f deploy/topologies/docker-compose.falkordb-standalone-tls.yml up -d

FALKORDB_TEST_MODE=standalone FALKORDB_TEST_HOST=127.0.0.1 FALKORDB_TEST_PORT=6379 \
FALKORDB_TEST_PASSWORD=testpass FALKORDB_TEST_TLS=1 \
FALKORDB_TEST_TLS_CA=deploy/topologies/certs/ca.crt \
pytest backend/tests/integration/test_topologies.py -v
```

## Standalone, no auth (and the stale-credential self-heal)

```bash
docker run -d --name falkordb-noauth -p 6379:6379 falkordb/falkordb:v4.18.11

# no credentials — the common dev/k8s shape
FALKORDB_TEST_MODE=standalone FALKORDB_TEST_HOST=127.0.0.1 \
pytest backend/tests/integration/test_topologies.py -v

# credentials configured ANYWAY: exercises the auth_not_configured self-heal
# (a stale row password must never take a healthy graph offline)
FALKORDB_TEST_MODE=standalone FALKORDB_TEST_HOST=127.0.0.1 \
FALKORDB_TEST_PASSWORD=stale-anything \
pytest backend/tests/integration/test_topologies.py -v

# live auth-flip drill (CONFIG SET requirepass mid-session → un-learn + reconnect)
FALKORDB_TEST_MODE=standalone FALKORDB_TEST_HOST=127.0.0.1 \
FALKORDB_TEST_ALLOW_CONFIG_SET=1 \
pytest backend/tests/integration/test_topologies.py -v -k auth_flip
```

## Sentinel (HA)

```bash
docker compose -f deploy/topologies/docker-compose.falkordb-sentinel.yml up -d

FALKORDB_TEST_MODE=sentinel FALKORDB_TEST_SENTINEL_MASTER=mymaster \
FALKORDB_TEST_SENTINEL_NODES=127.0.0.1:26379,127.0.0.1:26380,127.0.0.1:26381 \
FALKORDB_TEST_PASSWORD=testpass \
pytest backend/tests/integration/test_topologies.py -v

# Failover drill: docker kill <sentinel compose>_falkordb-master_1 ; re-run.
```

## Sentinel + TLS (data plane AND sentinel daemons)

```bash
./deploy/topologies/gen-certs.sh
docker compose -f deploy/topologies/docker-compose.falkordb-sentinel-tls.yml up -d

FALKORDB_TEST_MODE=sentinel FALKORDB_TEST_SENTINEL_MASTER=mymaster \
FALKORDB_TEST_SENTINEL_NODES=127.0.0.1:26379,127.0.0.1:26380,127.0.0.1:26381 \
FALKORDB_TEST_PASSWORD=testpass \
FALKORDB_TEST_TLS=1 FALKORDB_TEST_TLS_CA=deploy/topologies/certs/ca.crt \
pytest backend/tests/integration/test_topologies.py -v
```

`sentinel.tls` inherits the data-plane TLS by default; for a MIXED deployment
(TLS data plane, plaintext sentinels) set `FALKORDB_TEST_SENTINEL_TLS=0`.

## Cluster (Linux / host networking)

```bash
docker compose -f deploy/topologies/docker-compose.falkordb-cluster.yml up -d
docker compose -f deploy/topologies/docker-compose.falkordb-cluster.yml logs cluster-init

FALKORDB_TEST_MODE=cluster \
FALKORDB_TEST_CLUSTER_NODES=127.0.0.1:7000,127.0.0.1:7001,127.0.0.1:7002 \
FALKORDB_TEST_PASSWORD=testpass \
pytest backend/tests/integration/test_topologies.py -v
```

## Cluster announcing unreachable addresses (cross-GKE-cluster simulation)

The nodes announce bridge-internal IPs the host cannot route — what a client in
a **different** GKE cluster sees from the slot map / MOVED redirects. The run
fails without `addressRemap` and passes with it:

```bash
docker compose -f deploy/topologies/docker-compose.falkordb-cluster-remap.yml up -d

FALKORDB_TEST_MODE=cluster \
FALKORDB_TEST_CLUSTER_NODES=127.0.0.1:7000,127.0.0.1:7001,127.0.0.1:7002 \
FALKORDB_TEST_PASSWORD=testpass \
FALKORDB_TEST_ADDRESS_REMAP="172.28.0.10:7000=127.0.0.1:7000,172.28.0.11:7001=127.0.0.1:7001,172.28.0.12:7002=127.0.0.1:7002,172.28.0.13:7003=127.0.0.1:7003,172.28.0.14:7004=127.0.0.1:7004,172.28.0.15:7005=127.0.0.1:7005" \
pytest backend/tests/integration/test_topologies.py -v
```

In production the same mapping rides `falkordbConnection.addressRemap`
(`{"pod-ip:port": "reachable-endpoint:port"}`) or `FALKORDB_ADDRESS_REMAP`.

## The full matrix

| Mode | Auth | TLS | Harness | Extra env |
|---|---|---|---|---|
| standalone | none | no | `docker run falkordb/falkordb:v4.18.11` | — |
| standalone | none (stale creds configured) | no | same | `FALKORDB_TEST_PASSWORD=anything` (self-heal) |
| standalone | requirepass | yes | `docker-compose.falkordb-standalone-tls.yml` | `FALKORDB_TEST_TLS=1` + CA |
| sentinel | requirepass + masterauth | no | `docker-compose.falkordb-sentinel.yml` | — |
| sentinel | requirepass + masterauth | yes (daemons too) | `docker-compose.falkordb-sentinel-tls.yml` | `FALKORDB_TEST_TLS=1` + CA |
| cluster | requirepass | no | `docker-compose.falkordb-cluster.yml` | — |
| cluster | requirepass | no, unreachable announces | `docker-compose.falkordb-cluster-remap.yml` | `FALKORDB_TEST_ADDRESS_REMAP=...` |

## Orchestration / insights bus (separate Redis)

The aggregation + insights **bus** (job stream, locks, pub/sub, admission) is a
different Redis from the graph. It supports single-node + **Sentinel** + TLS
(Cluster is intentionally rejected). Configure the services via env:

```bash
# single node + TLS
REDIS_URL=rediss://:pw@redis:6379/0 REDIS_TLS_ENABLED=true \
REDIS_TLS_CA_CERTS=/certs/ca.crt

# Sentinel
REDIS_SENTINEL_MASTER=mymaster \
REDIS_SENTINEL_NODES=sentinel-1:26379,sentinel-2:26379,sentinel-3:26379 \
REDIS_PASSWORD=testpass REDIS_TLS_ENABLED=true REDIS_TLS_CA_CERTS=/certs/ca.crt
```

For a dedicated clustered **cache** (the provider's idempotency/ancestor/stats
cache, which is cross-slot-safe), point `CACHE_REDIS_URL` at it or run the graph
in cluster mode without a cache URL — the provider builds a `RedisCluster` cache
client automatically.

## Split streams/cache, independent auth + TLS

```bash
./deploy/topologies/gen-split-certs.sh
docker compose -f deploy/topologies/docker-compose.redis-split-auth-tls.yml up -d
```

Two independent Redis instances — different passwords, different CAs — proving
role isolation between the `STREAMS` and `CACHE` roles (`resolve_redis_config` /
`build_redis_client`, ADR-022): a credential or cert mistake in one role can
never authenticate against the other.
