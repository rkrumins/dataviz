#!/usr/bin/env bash
set -euo pipefail

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Synodic — GKE Deployment Script
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env.deploy"

# ── Colors ─────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color
BOLD='\033[1m'

info()  { echo -e "${BLUE}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; }
step()  { echo -e "\n${CYAN}${BOLD}━━━ $* ━━━${NC}\n"; }

# ── Pre-flight checks ─────────────────────────────────────────────
preflight() {
    local missing=()
    for cmd in gcloud kubectl docker; do
        if ! command -v "$cmd" &>/dev/null; then
            missing+=("$cmd")
        fi
    done
    if [[ ${#missing[@]} -gt 0 ]]; then
        error "Missing required tools: ${missing[*]}"
        echo "  Install gcloud: https://cloud.google.com/sdk/docs/install"
        echo "  Install kubectl: gcloud components install kubectl"
        echo "  Install docker: https://docs.docker.com/get-docker/"
        exit 1
    fi
    # Check gcloud auth
    if ! gcloud auth print-access-token &>/dev/null; then
        error "Not authenticated with gcloud. Run: gcloud auth login"
        exit 1
    fi
    ok "All prerequisites satisfied"
}

# ── Load .env.deploy ───────────────────────────────────────────────
load_env() {
    if [[ ! -f "$ENV_FILE" ]]; then
        error ".env.deploy not found. Run './deploy.sh setup' first."
        exit 1
    fi
    set -a
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +a
    ok "Loaded configuration from .env.deploy"
}

# ── Generate random string ────────────────────────────────────────
rand_string() {
    local len="${1:-32}"
    LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c "$len" 2>/dev/null || true
}

# ── Generate Fernet key ───────────────────────────────────────────
generate_fernet_key() {
    if command -v python3 &>/dev/null; then
        python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())" 2>/dev/null || \
        python3 -c "import base64,os; print(base64.urlsafe_b64encode(os.urandom(32)).decode())"
    else
        # Fallback: base64-encoded 32 random bytes
        head -c 32 /dev/urandom | base64 | tr -d '\n'
    fi
}

# ── Prompt with default ───────────────────────────────────────────
prompt() {
    local var_name="$1" prompt_text="$2" default="$3"
    local value
    echo -en "${BOLD}${prompt_text}${NC}"
    if [[ -n "$default" ]]; then
        echo -en " [${default}]: "
    else
        echo -en ": "
    fi
    read -r value
    value="${value:-$default}"
    eval "$var_name=\"$value\""
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# SETUP — Interactive first-time configuration
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
cmd_setup() {
    step "Synodic GKE Setup Wizard"
    preflight

    # ── GCP Configuration ──────────────────────────────────────────
    step "GCP Configuration"
    local detected_project
    detected_project="$(gcloud config get-value project 2>/dev/null || echo "")"

    prompt PROJECT_ID "GCP Project ID" "$detected_project"
    prompt REGION "GCP Region" "us-central1"
    prompt DOMAIN "Domain name (e.g. synodic.mycompany.com)" ""
    prompt CLUSTER_NAME "GKE Cluster name" "synodic-cluster"
    prompt ADMIN_EMAIL "Admin user email" "admin@synodic.local"

    local REGISTRY="${REGION}-docker.pkg.dev/${PROJECT_ID}/synodic"

    # ── Set active project ─────────────────────────────────────────
    step "Setting GCP project"
    gcloud config set project "$PROJECT_ID"
    ok "Active project: $PROJECT_ID"

    # ── Enable required APIs ───────────────────────────────────────
    step "Enabling GCP APIs"
    gcloud services enable \
        container.googleapis.com \
        artifactregistry.googleapis.com \
        compute.googleapis.com \
        --project="$PROJECT_ID" --quiet
    ok "APIs enabled"

    # ── Artifact Registry ──────────────────────────────────────────
    step "Creating Artifact Registry"
    if gcloud artifacts repositories describe synodic \
        --location="$REGION" --project="$PROJECT_ID" &>/dev/null; then
        ok "Artifact Registry 'synodic' already exists"
    else
        gcloud artifacts repositories create synodic \
            --repository-format=docker \
            --location="$REGION" \
            --description="Synodic container images" \
            --project="$PROJECT_ID"
        ok "Created Artifact Registry 'synodic'"
    fi

    # Configure Docker auth
    gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet
    ok "Docker configured for Artifact Registry"

    # ── GKE Cluster ────────────────────────────────────────────────
    step "GKE Cluster"
    if gcloud container clusters describe "$CLUSTER_NAME" \
        --region="$REGION" --project="$PROJECT_ID" &>/dev/null 2>&1; then
        ok "Cluster '$CLUSTER_NAME' already exists"
    else
        echo ""
        echo "  No cluster found. Choose cluster type:"
        echo "    1) Autopilot (recommended — fully managed, pay-per-pod)"
        echo "    2) Standard  (manual node management)"
        echo "    3) Skip      (I'll connect to an existing cluster later)"
        echo ""
        prompt CLUSTER_TYPE "Choice" "1"

        case "$CLUSTER_TYPE" in
            1)
                info "Creating Autopilot cluster (this takes 5-10 minutes)..."
                gcloud container clusters create-auto "$CLUSTER_NAME" \
                    --region="$REGION" \
                    --project="$PROJECT_ID"
                ok "Autopilot cluster created"
                ;;
            2)
                info "Creating Standard cluster (this takes 5-10 minutes)..."
                gcloud container clusters create "$CLUSTER_NAME" \
                    --region="$REGION" \
                    --project="$PROJECT_ID" \
                    --num-nodes=2 \
                    --machine-type=e2-standard-4 \
                    --enable-autoscaling \
                    --min-nodes=1 \
                    --max-nodes=5
                ok "Standard cluster created"
                ;;
            3)
                warn "Skipping cluster creation. Connect manually with:"
                echo "  gcloud container clusters get-credentials <name> --region <region>"
                ;;
        esac
    fi

    # Get cluster credentials
    if [[ "${CLUSTER_TYPE:-1}" != "3" ]]; then
        gcloud container clusters get-credentials "$CLUSTER_NAME" \
            --region="$REGION" --project="$PROJECT_ID"
        ok "kubectl configured for cluster '$CLUSTER_NAME'"
    fi

    # ── Static IP ──────────────────────────────────────────────────
    step "Reserving Static IP"
    local STATIC_IP
    if gcloud compute addresses describe synodic-ip --global --project="$PROJECT_ID" &>/dev/null 2>&1; then
        ok "Static IP 'synodic-ip' already exists"
    else
        gcloud compute addresses create synodic-ip --global --project="$PROJECT_ID"
        ok "Reserved global static IP"
    fi
    STATIC_IP="$(gcloud compute addresses describe synodic-ip --global --project="$PROJECT_ID" --format='value(address)')"
    info "Static IP: ${BOLD}${STATIC_IP}${NC}"
    echo ""
    warn "Point your DNS record to this IP:"
    echo "  ${DOMAIN}  →  A  ${STATIC_IP}"
    echo ""

    # ── Generate Secrets ───────────────────────────────────────────
    step "Generating Secrets"
    local POSTGRES_PASSWORD JWT_SECRET_KEY CREDENTIAL_ENCRYPTION_KEY ADMIN_PASSWORD

    POSTGRES_PASSWORD="$(rand_string 32)"
    JWT_SECRET_KEY="$(rand_string 64)"
    CREDENTIAL_ENCRYPTION_KEY="$(generate_fernet_key)"
    ADMIN_PASSWORD="$(rand_string 16)"

    ok "Generated cryptographically random secrets"

    # ── Write .env.deploy ──────────────────────────────────────────
    step "Writing .env.deploy"
    cat > "$ENV_FILE" <<ENVEOF
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Synodic GKE Deployment Configuration
# Generated by deploy.sh setup on $(date -u +"%Y-%m-%dT%H:%M:%SZ")
# DO NOT COMMIT THIS FILE — it contains secrets
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# GCP
PROJECT_ID=${PROJECT_ID}
REGION=${REGION}
REGISTRY=${REGISTRY}
CLUSTER_NAME=${CLUSTER_NAME}

# Domain
DOMAIN=${DOMAIN}

# Secrets
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
JWT_SECRET_KEY=${JWT_SECRET_KEY}
CREDENTIAL_ENCRYPTION_KEY=${CREDENTIAL_ENCRYPTION_KEY}
ADMIN_EMAIL=${ADMIN_EMAIL}
ADMIN_PASSWORD=${ADMIN_PASSWORD}
ENVEOF

    chmod 600 "$ENV_FILE"
    ok "Wrote ${ENV_FILE}"
    warn "This file contains secrets — it is gitignored and should never be committed."

    # ── Summary ────────────────────────────────────────────────────
    step "Setup Complete!"
    echo ""
    echo "  Project:    ${PROJECT_ID}"
    echo "  Region:     ${REGION}"
    echo "  Registry:   ${REGISTRY}"
    echo "  Cluster:    ${CLUSTER_NAME}"
    echo "  Domain:     ${DOMAIN}"
    echo "  Static IP:  ${STATIC_IP}"
    echo "  Admin:      ${ADMIN_EMAIL}"
    echo ""
    echo "  Next steps:"
    echo "    1. Point DNS:  ${DOMAIN}  →  A  ${STATIC_IP}"
    echo "    2. Deploy:     ./deploy.sh deploy dev"
    echo "    3. Verify:     ./deploy.sh status"
    echo ""
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# DEPLOY — Build, push, and apply
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
cmd_deploy() {
    local overlay="${1:-dev}"
    if [[ ! "$overlay" =~ ^(dev|staging|production)$ ]]; then
        error "Invalid overlay: $overlay (must be dev, staging, or production)"
        exit 1
    fi

    load_env
    preflight

    local TAG
    TAG="$(git rev-parse --short HEAD 2>/dev/null || echo "latest")"

    step "Building images (tag: ${TAG})"
    make -C "$SCRIPT_DIR" build TAG="$TAG"
    ok "All images built"

    step "Pushing images to ${REGISTRY}"
    make -C "$SCRIPT_DIR" push TAG="$TAG"
    ok "All images pushed"

    step "Creating namespace"
    kubectl create namespace synodic --dry-run=client -o yaml | kubectl apply -f -
    ok "Namespace ready"

    step "Injecting secrets"
    # Create secrets from .env.deploy values (idempotent)
    kubectl create secret generic db-credentials \
        --namespace=synodic \
        --from-literal=POSTGRES_USER=synodic \
        --from-literal=POSTGRES_PASSWORD="${POSTGRES_PASSWORD}" \
        --from-literal=POSTGRES_DB=synodic \
        --from-literal=MANAGEMENT_DB_URL="postgresql+asyncpg://synodic:${POSTGRES_PASSWORD}@postgres:5432/synodic" \
        --dry-run=client -o yaml | kubectl apply -f -

    kubectl create secret generic app-secrets \
        --namespace=synodic \
        --from-literal=JWT_SECRET_KEY="${JWT_SECRET_KEY}" \
        --from-literal=CREDENTIAL_ENCRYPTION_KEY="${CREDENTIAL_ENCRYPTION_KEY}" \
        --from-literal=ADMIN_EMAIL="${ADMIN_EMAIL}" \
        --from-literal=ADMIN_PASSWORD="${ADMIN_PASSWORD}" \
        --dry-run=client -o yaml | kubectl apply -f -
    ok "Secrets injected"

    step "Applying manifests (overlay: ${overlay})"
    make -C "$SCRIPT_DIR" apply OVERLAY="$overlay" TAG="$TAG"
    ok "Manifests applied"

    step "Deployment Complete!"
    echo ""
    echo "  Overlay:  ${overlay}"
    echo "  Tag:      ${TAG}"
    echo "  Domain:   ${DOMAIN}"
    echo ""
    echo "  Monitor rollout:"
    echo "    ./deploy.sh status"
    echo "    make -C deploy/k8s logs-viz-service"
    echo ""
    echo "  Note: GKE Ingress + TLS certificate may take 10-15 minutes to provision."
    echo "  Check: kubectl get managedcertificate -n synodic"
    echo ""
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# STATUS — Show cluster status
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
cmd_status() {
    step "Pod Status"
    kubectl get pods -n synodic -o wide 2>/dev/null || warn "No pods found in synodic namespace"

    step "Services"
    kubectl get svc -n synodic 2>/dev/null || true

    step "Ingress"
    kubectl get ingress -n synodic 2>/dev/null || warn "No ingress found"

    step "TLS Certificate"
    kubectl get managedcertificate -n synodic 2>/dev/null || warn "No managed certificate found"

    step "Persistent Volumes"
    kubectl get pvc -n synodic 2>/dev/null || true

    step "HPAs"
    kubectl get hpa -n synodic 2>/dev/null || true
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# SEED — Run the demo data seeder
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
cmd_seed() {
    load_env
    local TAG
    TAG="$(git rev-parse --short HEAD 2>/dev/null || echo "latest")"

    step "Running demo data seeder"
    make -C "$SCRIPT_DIR" seed TAG="$TAG"
    ok "Seed job submitted. Monitor with: kubectl logs -n synodic -l app.kubernetes.io/name=seed -f"
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# TEARDOWN — Delete everything
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
cmd_teardown() {
    step "Teardown"
    warn "This will DELETE the entire synodic namespace and all its resources."
    warn "Persistent volumes will be LOST."
    echo ""
    prompt CONFIRM "Type 'yes-delete-everything' to confirm" ""
    if [[ "$CONFIRM" != "yes-delete-everything" ]]; then
        info "Aborted."
        exit 0
    fi
    kubectl delete namespace synodic
    ok "Namespace 'synodic' deleted."
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# MAIN
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
usage() {
    echo ""
    echo "Usage: $0 <command> [args]"
    echo ""
    echo "Commands:"
    echo "  setup               First-time setup wizard (GCP project, cluster, registry, secrets)"
    echo "  deploy <overlay>    Build, push, and apply (dev|staging|production)"
    echo "  status              Show cluster status (pods, ingress, certs)"
    echo "  seed                Run demo data seeder"
    echo "  teardown            Delete the synodic namespace (with confirmation)"
    echo ""
    echo "Examples:"
    echo "  $0 setup                  # Interactive first-time setup"
    echo "  $0 deploy dev             # Deploy to dev overlay"
    echo "  $0 deploy production      # Deploy to production"
    echo "  $0 status                 # Check deployment status"
    echo ""
}

case "${1:-}" in
    setup)    cmd_setup ;;
    deploy)   cmd_deploy "${2:-}" ;;
    status)   cmd_status ;;
    seed)     cmd_seed ;;
    teardown) cmd_teardown ;;
    help|-h|--help) usage ;;
    *)
        error "Unknown command: ${1:-}"
        usage
        exit 1
        ;;
esac
