#!/bin/sh
# Build (and push) the dataviz container images to a registry: every image the Helm chart pulls,
# the schema-upgrade image `synodic-upgrade` among them, and `seed`.
#
#   REGISTRY  registry host           (default: docker.io)
#   ORG       org / namespace         (default: synodic)
#   TAG       image tag               (default: latest)
#   PUSH      push after build        (default: true; set false to build only)
#   MAIN_REF  what counts as main     (default: origin/main)
#
# Examples:
#   sh deploy/build-images.sh
#   REGISTRY=docker.io ORG=myorg TAG=v1.2.3 sh deploy/build-images.sh
#   PUSH=false TAG=test sh deploy/build-images.sh
#
# Each image records the commit it was built from, and whether that commit is on main with
# nothing uncommitted under backend/ (SYNODIC_BUILD_*; the OCI revision label). On a shared
# database (Helm: upgrade.sharedDatabase) the upgrade Job migrates only from a build of main.
#
# Run from the repo root (build context is the repo root for every image).

set -eu

REGISTRY="${REGISTRY:-docker.io}"
ORG="${ORG:-synodic}"
TAG="${TAG:-latest}"
PUSH="${PUSH:-true}"
MAIN_REF="${MAIN_REF:-origin/main}"

# name<TAB>dockerfile  (build context is always ".")
IMAGES="
viz-service	backend/Dockerfile.viz
aggregation-controlplane	backend/Dockerfile.controlplane
aggregation-worker	backend/Dockerfile.aggregation
stats-service	backend/Dockerfile.insights
ai-service	backend/Dockerfile.ai
frontend	frontend/Dockerfile
synodic-upgrade	backend/Dockerfile.upgrade
seed	backend/Dockerfile.seed
"

if [ ! -f docker-compose.yml ]; then
  echo "ERROR: run this from the repo root (docker-compose.yml not found)." >&2
  exit 1
fi

SHA="$(git rev-parse HEAD 2>/dev/null || true)"
REF="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
ON_MAIN=false
if [ -n "$SHA" ]; then
  git fetch -q origin main 2>/dev/null || echo "note: couldn't fetch main; judging against ${MAIN_REF} as it is" >&2
  if git merge-base --is-ancestor HEAD "$MAIN_REF" 2>/dev/null && [ -z "$(git status --porcelain -- backend)" ]; then
    ON_MAIN=true
  fi
fi
echo "==> building ${REF:-?} at ${SHA:-an unrecorded commit} (on main: ${ON_MAIN})"

echo "$IMAGES" | while IFS='	' read -r name dockerfile; do
  [ -z "$name" ] && continue
  ref="${REGISTRY}/${ORG}/${name}:${TAG}"
  echo "==> build ${ref}  (-f ${dockerfile})"
  docker build -f "${dockerfile}" -t "${ref}" \
    --build-arg SYNODIC_BUILD_SHA="${SHA}" \
    --build-arg SYNODIC_BUILD_REF="${REF}" \
    --build-arg SYNODIC_BUILD_ON_MAIN="${ON_MAIN}" .
  if [ "${PUSH}" = "true" ]; then
    echo "==> push  ${ref}"
    docker push "${ref}"
  fi
done

echo "Done. Images tagged ${REGISTRY}/${ORG}/<name>:${TAG}"
