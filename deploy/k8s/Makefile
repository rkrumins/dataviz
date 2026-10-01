# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Synodic — GKE Deployment Makefile
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#
# Source configuration from .env.deploy if it exists
-include .env.deploy
export

# Defaults (overridable via .env.deploy or environment)
PROJECT_ID   ?= $(shell gcloud config get-value project 2>/dev/null)
REGION       ?= us-central1
REGISTRY     ?= $(REGION)-docker.pkg.dev/$(PROJECT_ID)/synodic
TAG          ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo "latest")
OVERLAY      ?= dev
REPO_ROOT    := $(shell cd ../.. && pwd)

# The production-cluster overlay pins its shard StatefulSets + init Job to this
# tag. Deliberately NOT $(TAG): `apply` rewrites :prod-latest to the per-commit
# tag, so every app deploy changed the shard pod template and replaced every
# shard pod (restartCount 0, then a full reload). Bump it — and run
# build/push-falkordb-cluster — only when the FalkorDB image itself changes.
FALKORDB_CLUSTER_TAG ?= v4.20.6-1

# The ONLY placeholders `apply` substitutes into the rendered manifests. Scoped on
# purpose: a bare `envsubst` also rewrites every $VAR / ${VAR} inside the shell
# scripts embedded in manifests (the cluster-init Job, the DR backup CronJob),
# blanking them because they are not set in the deploy environment. Naming the
# variables leaves everything else verbatim. Add a var here when a manifest needs
# a new deploy-time value.
ENVSUBST_VARS := '$$DB_HOST $$REDIS_COORD_HOST $$REDIS_CACHE_HOST $$POSTGRES_PASSWORD \
                  $$JWT_SECRET_KEY $$JWT_SECRET_KEY_PREVIOUS \
                  $$CREDENTIAL_ENCRYPTION_KEY $$AGGREGATION_INTERNAL_TOKEN \
                  $$ADMIN_EMAIL $$ADMIN_PASSWORD $$FALKORDB_BACKUP_BUCKET \
                  $$REDIS_STREAMS_PASSWORD $$REDIS_CACHE_PASSWORD \
                  $$REDIS_STREAMS_TLS_ENABLED $$REDIS_CACHE_TLS_ENABLED'

.PHONY: help build push deploy apply dry-run status seed \
        build-viz build-controlplane build-worker build-stats build-frontend build-falkordb build-seed \
        push-viz push-controlplane push-worker push-stats push-frontend push-falkordb push-seed \
        build-falkordb-cluster push-falkordb-cluster

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-24s\033[0m %s\n", $$1, $$2}'

# ── Build ──────────────────────────────────────────────────────────

build-viz: ## Build viz-service image
	docker build -t $(REGISTRY)/viz-service:$(TAG) -f $(REPO_ROOT)/backend/Dockerfile.viz $(REPO_ROOT)

build-controlplane: ## Build controlplane image
	docker build -t $(REGISTRY)/aggregation-controlplane:$(TAG) -f $(REPO_ROOT)/backend/Dockerfile.controlplane $(REPO_ROOT)

build-worker: ## Build aggregation worker image
	docker build -t $(REGISTRY)/aggregation-worker:$(TAG) -f $(REPO_ROOT)/backend/Dockerfile.aggregation $(REPO_ROOT)

build-stats: ## Build stats/insights service image
	docker build -t $(REGISTRY)/stats-service:$(TAG) -f $(REPO_ROOT)/backend/Dockerfile.insights $(REPO_ROOT)

build-frontend: ## Build frontend image
	docker build -t $(REGISTRY)/frontend:$(TAG) -f $(REPO_ROOT)/frontend/Dockerfile $(REPO_ROOT)

build-falkordb: ## Build pre-populated FalkorDB image
	docker build -t $(REGISTRY)/falkordb:$(TAG) -f $(REPO_ROOT)/data/quickstart/Dockerfile.falkordb $(REPO_ROOT)/data/quickstart

build-seed: ## Build seed job image
	docker build -t $(REGISTRY)/seed:$(TAG) -f $(REPO_ROOT)/backend/Dockerfile.seed $(REPO_ROOT)

build: build-viz build-controlplane build-worker build-stats build-frontend build-falkordb build-seed ## Build all images

# Kept OUT of build/push: the pinned tag is rebuilt only on purpose (see
# FALKORDB_CLUSTER_TAG), never as a side effect of an app deploy.
build-falkordb-cluster: ## Build the FalkorDB image pinned by production-cluster (FALKORDB_CLUSTER_TAG)
	docker build -t $(REGISTRY)/falkordb:$(FALKORDB_CLUSTER_TAG) -f $(REPO_ROOT)/data/quickstart/Dockerfile.falkordb $(REPO_ROOT)/data/quickstart

# ── Push ───────────────────────────────────────────────────────────

push-viz: ## Push viz-service image
	docker push $(REGISTRY)/viz-service:$(TAG)

push-controlplane: ## Push controlplane image
	docker push $(REGISTRY)/aggregation-controlplane:$(TAG)

push-worker: ## Push worker image
	docker push $(REGISTRY)/aggregation-worker:$(TAG)

push-stats: ## Push stats/insights service image
	docker push $(REGISTRY)/stats-service:$(TAG)

push-frontend: ## Push frontend image
	docker push $(REGISTRY)/frontend:$(TAG)

push-falkordb: ## Push FalkorDB image
	docker push $(REGISTRY)/falkordb:$(TAG)

push-seed: ## Push seed image
	docker push $(REGISTRY)/seed:$(TAG)

push: push-viz push-controlplane push-worker push-stats push-frontend push-falkordb push-seed ## Push all images

push-falkordb-cluster: ## Push the FalkorDB image pinned by production-cluster (FALKORDB_CLUSTER_TAG)
	docker push $(REGISTRY)/falkordb:$(FALKORDB_CLUSTER_TAG)

# ── Deploy ─────────────────────────────────────────────────────────

dry-run: ## Preview rendered manifests
	@cd $(CURDIR) && kubectl kustomize overlays/$(OVERLAY) | \
		sed "s|gcr.io/PROJECT_ID|$(REGISTRY)|g" | \
		sed "s|us-docker.pkg.dev/PROJECT_ID/synodic|$(REGISTRY)|g" | \
		sed "s|:dev-latest|:$(TAG)|g" | \
		sed "s|:staging-latest|:$(TAG)|g" | \
		sed "s|:prod-latest|:$(TAG)|g" | \
		sed "s|:v1.0.0|:$(TAG)|g"

apply: ## Apply manifests to the cluster
	@cd $(CURDIR) && kubectl kustomize overlays/$(OVERLAY) | \
		sed "s|gcr.io/PROJECT_ID|$(REGISTRY)|g" | \
		sed "s|us-docker.pkg.dev/PROJECT_ID/synodic|$(REGISTRY)|g" | \
		sed "s|:dev-latest|:$(TAG)|g" | \
		sed "s|:staging-latest|:$(TAG)|g" | \
		sed "s|:prod-latest|:$(TAG)|g" | \
		sed "s|:v1.0.0|:$(TAG)|g" | \
		envsubst $(ENVSUBST_VARS) | kubectl apply -f -

deploy: build push apply ## Full pipeline: build → push → apply

# ── Seed ──────────────────────────────────────────────────────────

seed: ## Run the optional demo data seeder job
	@cd $(CURDIR) && cat base/services/seed/job.yaml | \
		sed "s|REGISTRY/seed:latest|$(REGISTRY)/seed:$(TAG)|g" | \
		kubectl apply -n synodic -f -

# ── Utilities ──────────────────────────────────────────────────────

status: ## Show pod status in synodic namespace
	@kubectl get pods -n synodic -o wide
	@echo ""
	@kubectl get ingress -n synodic 2>/dev/null || true
	@echo ""
	@kubectl get managedcertificate -n synodic 2>/dev/null || true

logs-%: ## Tail logs for a service (e.g. make logs-viz-service)
	kubectl logs -n synodic -l app.kubernetes.io/name=$* -f --tail=100

rollout-%: ## Check rollout status (e.g. make rollout-viz-service)
	kubectl rollout status deployment/$* -n synodic

restart-%: ## Restart a deployment (e.g. make restart-viz-service)
	kubectl rollout restart deployment/$* -n synodic

port-forward-frontend: ## Port-forward frontend to localhost:8080
	kubectl port-forward -n synodic svc/frontend 8080:80

port-forward-viz: ## Port-forward viz-service to localhost:8000
	kubectl port-forward -n synodic svc/viz-service 8000:8000

port-forward-falkordb: ## Port-forward FalkorDB UI to localhost:3000
	kubectl port-forward -n synodic svc/falkordb 3000:3000
