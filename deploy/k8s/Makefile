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

.PHONY: help build push deploy apply dry-run status seed \
        build-viz build-controlplane build-worker build-graph build-frontend build-falkordb build-seed \
        push-viz push-controlplane push-worker push-graph push-frontend push-falkordb push-seed

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-24s\033[0m %s\n", $$1, $$2}'

# ── Build ──────────────────────────────────────────────────────────

build-viz: ## Build viz-service image
	docker build -t $(REGISTRY)/viz-service:$(TAG) -f $(REPO_ROOT)/backend/Dockerfile.viz $(REPO_ROOT)

build-controlplane: ## Build controlplane image
	docker build -t $(REGISTRY)/controlplane:$(TAG) -f $(REPO_ROOT)/backend/Dockerfile.controlplane $(REPO_ROOT)

build-worker: ## Build aggregation worker image
	docker build -t $(REGISTRY)/worker:$(TAG) -f $(REPO_ROOT)/backend/Dockerfile.aggregation $(REPO_ROOT)

build-graph: ## Build graph-service image
	docker build -t $(REGISTRY)/graph-service:$(TAG) -f $(REPO_ROOT)/backend/Dockerfile.graph $(REPO_ROOT)

build-frontend: ## Build frontend image
	docker build -t $(REGISTRY)/frontend:$(TAG) -f $(REPO_ROOT)/frontend/Dockerfile $(REPO_ROOT)

build-falkordb: ## Build pre-populated FalkorDB image
	docker build -t $(REGISTRY)/falkordb:$(TAG) -f $(REPO_ROOT)/data/quickstart/Dockerfile.falkordb $(REPO_ROOT)/data/quickstart

build-seed: ## Build seed job image
	docker build -t $(REGISTRY)/seed:$(TAG) -f $(REPO_ROOT)/backend/Dockerfile.seed $(REPO_ROOT)

build: build-viz build-controlplane build-worker build-graph build-frontend build-falkordb build-seed ## Build all images

# ── Push ───────────────────────────────────────────────────────────

push-viz: ## Push viz-service image
	docker push $(REGISTRY)/viz-service:$(TAG)

push-controlplane: ## Push controlplane image
	docker push $(REGISTRY)/controlplane:$(TAG)

push-worker: ## Push worker image
	docker push $(REGISTRY)/worker:$(TAG)

push-graph: ## Push graph-service image
	docker push $(REGISTRY)/graph-service:$(TAG)

push-frontend: ## Push frontend image
	docker push $(REGISTRY)/frontend:$(TAG)

push-falkordb: ## Push FalkorDB image
	docker push $(REGISTRY)/falkordb:$(TAG)

push-seed: ## Push seed image
	docker push $(REGISTRY)/seed:$(TAG)

push: push-viz push-controlplane push-worker push-graph push-frontend push-falkordb push-seed ## Push all images

# ── Deploy ─────────────────────────────────────────────────────────

dry-run: ## Preview rendered manifests
	@cd $(CURDIR) && kubectl kustomize overlays/$(OVERLAY) | \
		sed "s|gcr.io/PROJECT_ID|$(REGISTRY)|g" | \
		sed "s|us-docker.pkg.dev/PROJECT_ID/synodic|$(REGISTRY)|g" | \
		sed "s|:dev-latest|:$(TAG)|g" | \
		sed "s|:staging-latest|:$(TAG)|g" | \
		sed "s|:v1.0.0|:$(TAG)|g"

apply: ## Apply manifests to the cluster
	@cd $(CURDIR) && kubectl kustomize overlays/$(OVERLAY) | \
		sed "s|gcr.io/PROJECT_ID|$(REGISTRY)|g" | \
		sed "s|us-docker.pkg.dev/PROJECT_ID/synodic|$(REGISTRY)|g" | \
		sed "s|:dev-latest|:$(TAG)|g" | \
		sed "s|:staging-latest|:$(TAG)|g" | \
		sed "s|:v1.0.0|:$(TAG)|g" | \
		envsubst | kubectl apply -f -

deploy: build push apply ## Full pipeline: build → push → apply

# ── Seed ──────────────────────────────────────────────────────────

seed: ## Run the optional demo data seeder job
	@cd $(CURDIR) && cat base/services/seed/job.yaml | \
		sed "s|REGISTRY/synodic-seed:latest|$(REGISTRY)/seed:$(TAG)|g" | \
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
