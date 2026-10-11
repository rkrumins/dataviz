# deploy/k8s — kustomize manifests for GKE

The full procedure — first-time setup, deploying an overlay, the schema upgrade, production
settings, secrets, Cloud SQL and Memorystore, verifying, upgrading and troubleshooting — is
[Deploying on Kubernetes](../../docs/KUBERNETES.md). The FalkorDB cluster overlay has its own
page: [overlays/production-cluster/README.md](overlays/production-cluster/README.md).

## Before you deploy

- **These manifests run no schema migration.** Run the schema-upgrade Job from the guide after
  the first deploy and before each release that changes the schema; until then `viz-service`
  stays not ready.
- **The FalkorDB StatefulSets mount their volume at `/data`,** but the image keeps its data in
  `/var/lib/falkordb/data`. Add the guide's mount patch to your overlay before you load data.
- **One environment per cluster.** Every overlay deploys into the `synodic` namespace.
- **Run `./deploy.sh setup` once.** Running it again generates new secrets and overwrites
  `.env.deploy`. Keep that file in your secrets store; it is gitignored.

## Commands

Run from this directory.

| Command | Does |
|---|---|
| `./deploy.sh setup` | Interactive first-time setup: GCP project, Artifact Registry, GKE cluster, static IP `synodic-ip`, generated secrets — all written to `.env.deploy` |
| `./deploy.sh deploy <dev\|staging\|production>` | Builds and pushes every image tagged with the current commit, creates the `synodic` namespace and the Secrets, applies the overlay |
| `./deploy.sh status` | Pods, Services, Ingress, certificate, volumes and autoscalers |
| `./deploy.sh seed` | Runs the demo-data seed Job |
| `./deploy.sh teardown` | Deletes the `synodic` namespace, after you type `yes-delete-everything` |

`Makefile` targets, for finer control (`make help` lists them):

| Target | Does |
|---|---|
| `make build` / `make push` | Build or push every image; `build-viz`, `push-worker` and so on for one |
| `make apply OVERLAY=<overlay> TAG=<tag>` | Render the overlay, fill in `.env.deploy` values, apply — the only way to deploy `production-cluster` |
| `make dry-run OVERLAY=<overlay>` | Print the rendered manifests without applying |
| `make logs-<service>`, `make rollout-<service>`, `make restart-<service>` | Follow logs, watch a rollout, restart a Deployment |
| `make port-forward-frontend` | The web app on `http://localhost:8080` |
| `make seed`, `make status` | As the `deploy.sh` commands |

## Layout

```
deploy/k8s/
├── deploy.sh               setup / deploy / status / seed / teardown
├── Makefile                build, push, apply (envsubst of .env.deploy values)
├── .env.deploy.example     every setting .env.deploy can hold, explained
├── base/                   namespace, service accounts, ConfigMaps, Secret templates,
│                           Postgres / Redis / FalkorDB StatefulSets, the app Deployments,
│                           GKE Ingress + managed certificate, NetworkPolicies
├── overlays/
│   ├── dev/                1 replica, smallest requests, DEBUG logs, AUTH_ENVIRONMENT_ID=dev
│   ├── staging/            base sizing, AUTH_ENVIRONMENT_ID=staging
│   ├── production/         Cloud SQL + Memorystore, 3 replicas, anti-affinity,
│   │                       graph-store backup CronJob, AUTH_ENVIRONMENT_ID=production
│   └── production-cluster/ production + FalkorDB as a 3-shard Redis Cluster
├── loadtest/               opt-in load generator — see loadtest/README.md
└── secret.example.yaml     old template for the Helm path's Secret; not used here
```
