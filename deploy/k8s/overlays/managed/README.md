# overlays/managed — Cloud SQL + Memorystore via a proxy-VM sidecar

Switches dataviz off the in-cluster Postgres + Redis StatefulSets and
onto managed Cloud SQL + Memorystore reached through a dual-NIC proxy
VM. FalkorDB stays in-cluster (no managed equivalent).

## What it does

- **Deletes** the in-cluster `postgres` + `redis` StatefulSets and
  their Services (`patches/delete-stores.yaml`).
- **Injects two native sidecars** (`db-proxy`, `redis-proxy` — socat,
  rendered as `initContainers` with `restartPolicy: Always`) into
  `aggregation-controlplane`, `aggregation-worker`, and `viz-service`.
  Each sidecar listens on `127.0.0.1:5432` / `127.0.0.1:6379` inside
  the pod and TCP-forwards to the proxy VM's NIC0 address.
- **Rewrites the wait-for-deps initContainer** to drop the
  `nc -z postgres 5432` / `nc -z redis 6379` checks — those Services
  no longer exist, so the old script would loop forever in `Init:0/1`.
- **Patches the `common-config` ConfigMap** so `REDIS_URL` and
  `CACHE_REDIS_URL` point at `127.0.0.1` instead of the in-cluster
  `redis` DNS name.
- **Holds the proxy VM address in a single ConfigMap** (`proxy-config`).
  Every sidecar reads `VM_HOST` from it via env var, so you edit one
  place and all four pods pick it up.
- **Patches the `db-credentials` Secret** so `MANAGEMENT_DB_URL` uses
  host `127.0.0.1`. Other keys (user, password placeholder, db name)
  merge in from the base.

## Prerequisites

- **GKE 1.29 or newer.** The sidecars use the native sidecar pattern
  (`restartPolicy: Always` on an initContainer). The `SidecarContainers`
  feature gate is beta-on-by-default in 1.29 and GA in 1.33. On older
  clusters, replace `restartPolicy: Always` with a regular sidecar
  container under `containers:` and accept the (small) startup race —
  the worker / stats preflight in
  `backend/app/services/aggregation/__main__.py` has a 5 s timeout, so
  socat must beat that.
- The proxy VM described below.

## Prerequisites on the VM (out of scope for this overlay)

The VM must do **L4 TCP forwarding** of arbitrary binary protocols. An
HTTP-aware proxy like Squid will not work — Postgres and Redis send
binary bytes as the first thing on the wire and Squid drops them.
Use HAProxy in `mode tcp` or nginx with the `stream` module:

```cfg
# /etc/haproxy/haproxy.cfg — minimal example
defaults
  mode tcp
  timeout connect 5s
  timeout client  1h
  timeout server  1h
frontend pg_in
  bind <NIC0-IP>:5432
  default_backend cloudsql_pg
backend cloudsql_pg
  server cloudsql <CLOUDSQL-PRIVATE-IP>:5432 check inter 5s
frontend redis_in
  bind <NIC0-IP>:6379
  default_backend memorystore_redis
backend memorystore_redis
  server redis <MEMORYSTORE-PRIVATE-IP>:6379 check inter 5s
```

Validate from a GKE *node* before deploying this overlay — `nc -vz`
only proves TCP handshake, not protocol compatibility:

```sh
kubectl debug node/<node> --image=postgres:16-alpine -- \
    psql "postgresql://USER:PASS@<NIC0-IP>:5432/synodic" -c 'select 1'
kubectl debug node/<node> --image=redis:7-alpine -- \
    redis-cli -h <NIC0-IP> ping
```

## Deploy

```sh
# 1. Set the proxy VM IP.
sed -i 's/REPLACE_ME_PROXY_VM_IP/10.0.0.5/' \
    deploy/k8s/overlays/managed/proxy-config.yaml

# 2. Render and apply, substituting the Cloud SQL password into the
#    base/overlay db-credentials Secret. The overlay already rewrites
#    MANAGEMENT_DB_URL's host to 127.0.0.1; envsubst fills in the
#    password placeholder.
POSTGRES_PASSWORD='<cloudsql-password>' \
    kustomize build deploy/k8s/overlays/managed | envsubst | kubectl apply -f -

# (Alternative) skip the templated Secret and create one out-of-band:
kubectl -n synodic create secret generic db-credentials \
  --from-literal=POSTGRES_USER=synodic \
  --from-literal=POSTGRES_PASSWORD='...' \
  --from-literal=POSTGRES_DB=synodic \
  --from-literal=MANAGEMENT_DB_URL='postgresql+asyncpg://synodic:...@127.0.0.1:5432/synodic'
```

## Verifying

```sh
kubectl -n synodic get pods                            # each backend is 3/3 Ready
kubectl -n synodic logs deploy/aggregation-controlplane -c db-proxy
kubectl -n synodic exec deploy/aggregation-controlplane -c aggregation-controlplane -- \
    nc -zv 127.0.0.1 5432                              # sidecar reachable
kubectl -n synodic exec deploy/aggregation-controlplane -c aggregation-controlplane -- \
    nc -zv 127.0.0.1 6379                              # redis sidecar reachable
```

If a pod is stuck `Init:0/N`, the wait-for-deps patch didn't land
(check `kubectl describe pod`). If a pod is `Init:N/M` waiting on
`db-proxy`, the sidecar can't reach the VM — check
`kubectl logs <pod> -c db-proxy` and the VM-side firewall.

## Combining with env overlays (production / staging)

This overlay extends `base`, not `overlays/production`. To stack
production replicas / resource limits on top of managed services,
create `overlays/production-managed/` that lists both as resources:

```yaml
resources:
  - ../production
  - ../managed
```

Note that the `production` overlay applies its own
`common-config` LOG_LEVEL patch; layering order matters — patches
from this overlay should win for the Redis URL keys (they're different
keys, so there's no actual conflict).

## Schema bootstrap

The base manifests do not include a db-init Job — the Kustomize path
assumes in-cluster Postgres which self-bootstraps. With Cloud SQL you
must create the `synodic` role + database + `aggregation` schema once.
Either install via Helm (`deploy/helm/dataviz`, which ships a
pre-install `dataviz-db-init` Hook), or run
`deploy/postgres-init/*.sql` against the instance manually:

```sh
psql "postgresql://postgres:<superuser-pw>@127.0.0.1:5432/postgres" \
     -f deploy/postgres-init/01-roles.sql
psql "postgresql://postgres:<superuser-pw>@127.0.0.1:5432/synodic" \
     -f deploy/postgres-init/02-schemas.sql
```
