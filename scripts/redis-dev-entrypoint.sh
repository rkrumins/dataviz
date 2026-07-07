#!/bin/sh
# Self-heals a corrupted dev Redis RDB snapshot before redis-server starts.
# Wired in as the container's own ENTRYPOINT (docker-compose.dev.yml) so it
# runs on every startup path -- `./dev.sh up`, `docker start`, `docker
# restart`, and the `restart: unless-stopped` policy alike -- not just when
# launched through dev.sh's host-side preflight.
#
# Root cause: when the Docker VM disk fills mid-RDB-write, the write can
# still land a truncated/zeroed dump.rdb, so its header no longer starts
# with the RDB magic "REDIS". Redis then treats it as fatal ("Wrong
# signature trying to load DB from file") and exits 1 forever under the
# restart policy. Since this is disposable dev cache data, quarantining the
# bad file and letting Redis boot empty is safe and unblocks the crash loop
# automatically.
set -eu

RDB=/data/dump.rdb
if [ -f "$RDB" ]; then
    magic=$(od -An -tx1 -N5 "$RDB" | tr -d ' \n')
    if [ "$magic" != "5245444953" ]; then
        ts=$(date +%Y%m%d-%H%M%S)
        echo "[redis-entrypoint] corrupt dump.rdb (magic=$magic, want 5245444953/REDIS) -- quarantining as dump.rdb.corrupt-$ts" >&2
        mv "$RDB" "$RDB.corrupt-$ts"
    fi
fi

exec docker-entrypoint.sh "$@"
