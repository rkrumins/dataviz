#!/bin/sh
# Keeps the dev frontend's node_modules in step with package-lock.json.
# Wired in as the container's own ENTRYPOINT (docker-compose.dev.yml) so it
# runs on every startup path -- `./dev.sh up`, `docker start`, `docker
# restart`, and the `restart: unless-stopped` policy alike.
#
# Root cause: /app/node_modules is a Docker volume, not part of the
# bind-mounted source, so a host `npm ci` never reaches it, and Docker seeds
# it from the image only when the volume is first created. A dependency
# merged after that (minisearch, 2026-10-11) is missing in the container and
# Vite fails with `Failed to resolve import "<pkg>"`, however often the image
# or the host is reinstalled. So reinstall here whenever the lockfile -- or
# the Node runtime the modules were installed under -- differs from the last
# install into this volume. An unchanged lockfile costs one hash, no network.
set -eu

cd /app
STAMP=node_modules/.dev-install-stamp
want=$({ cat package-lock.json; node --version; } | sha256sum | cut -d' ' -f1)

if [ "$(cat "$STAMP" 2>/dev/null || true)" != "$want" ]; then
    echo "[frontend-entrypoint] node_modules does not match package-lock.json -- running npm ci" >&2
    # Same flags as the image's deps stage (frontend/Dockerfile). npm ci
    # empties node_modules entry by entry, so it works on a mount point.
    npm ci --ignore-scripts --no-audit --no-fund
    echo "$want" > "$STAMP"
fi

exec docker-entrypoint.sh "$@"
