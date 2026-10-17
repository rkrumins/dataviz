# deploy/

Files for running the platform on Kubernetes. The how-to — choosing between kustomize and
Helm, building the images, secrets, the schema upgrade, verifying, upgrading and
troubleshooting — is [Deploying on Kubernetes](../docs/KUBERNETES.md). Read its
**Known gaps and their workarounds** section before your first deploy.

For a single server with Docker Compose, use [Self-Host Deployment](../docs/DEPLOYMENT.md)
and `deploy.sh` at the repository root instead.

## What's here

| Path | What it is |
|---|---|
| `k8s/` | Kustomize manifests for GKE — `base/`, the `dev`, `staging` and `production` overlays, and the `production-cluster` overlay that runs FalkorDB as a 3-shard Redis Cluster — driven by `k8s/deploy.sh` and `k8s/Makefile`. See [k8s/README.md](k8s/README.md). |
| `helm/dataviz/` | Helm chart for any cluster behind ingress-nginx. Settings in `values.yaml`. |
| `postgres-init/` | Reference SQL for the database role (`01-roles.sql`) and its schemas (`02-schemas.sql`). |
| `topologies/` | Docker Compose harnesses that stand up FalkorDB and Redis in each supported topology (standalone, Sentinel, Cluster, with auth and TLS) for the topology integration tests — not production manifests. See [topologies/README.md](topologies/README.md). |
| `build-images.sh` | Out of date: it stops at an image for a retired service and doesn't build `synodic-upgrade`, which the Helm chart needs. Use the build loop in the Kubernetes guide. |
