#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────
# Dev-only self-heal for FalkorDB's engine-version-locked AOF incremental.
#
# Wired as the dev falkordb container ENTRYPOINT (docker-compose.dev.yml), so
# it runs on EVERY startup path -- `./dev.sh up`, `docker start/restart`, and
# the `restart: unless-stopped` policy alike.
#
# Root cause it heals: FalkorDB's AOF *incremental* (appendonlydir/*.incr.aof)
# is a version-specific binary GRAPH.EFFECT opcode stream. After the image tag
# is bumped, replaying an incr written by the PREVIOUS engine can NULL-deref
# -> SIGSEGV during the startup AOF load (AttributeSet_Update), and
# `restart: unless-stopped` then loops forever. The RDB *base* is portable
# across engine versions; only the incr is not.
#
# Unlike redis-dev-entrypoint.sh, the poison is NOT detectable by a header
# magic check -- the incr file is well-formed, it just isn't replay-compatible.
# The only signal is that the process CRASHES during load, before it is ready.
# So this guard is a crash-LOOP detector: it arms a marker before starting
# redis and clears it once redis is actually ready; a marker still present at
# the next boot means the previous boot died before ready. After two such
# deaths in a row (so a one-off stop-mid-load is not mistaken for a crash) it
# quarantines the incr + resets the manifest to the portable base RDB, then
# lets the normal path retry. Bounded, loud, quarantine-not-delete, so a
# genuinely-bad base surfaces as a VISIBLE crash instead of silent data loss.
# NO-OP on healthy startups.
# ─────────────────────────────────────────────────────────────────────────
set -u

DATA_DIR="${FALKORDB_DATA_PATH:-/var/lib/falkordb/data}"
AOF_DIR="$DATA_DIR/appendonlydir"
MANIFEST="$AOF_DIR/appendonly.aof.manifest"
MARKER="$DATA_DIR/.dev-heal-boot"     # boot-in-progress counter (crash detector)
QUARANTINE_AFTER=2                     # consecutive pre-ready deaths before acting
MAX_HEAL=4                             # hard cap so a bad base can't loop-heal
RUN=/var/lib/falkordb/bin/run.sh

log() { echo "[falkordb-entrypoint] $*" >&2; }

incr_present() {
    # true if the manifest references any non-base (incr/history) file
    awk 'NF>=6 && $6!="b"{found=1} END{exit found?0:1}' "$MANIFEST" 2>/dev/null
}

quarantine_incr() {
    ts=$(date +%Y%m%d-%H%M%S)
    qdir="$DATA_DIR/appendonlydir.poison-$ts"
    mkdir -p "$qdir" || return 1
    log "QUARANTINE: moving incremental/history AOF -> $qdir, resetting manifest to base-only"
    awk 'NF>=6 && $6!="b"{print $2}' "$MANIFEST" 2>/dev/null | while IFS= read -r f; do
        [ -n "$f" ] && [ -e "$AOF_DIR/$f" ] && mv "$AOF_DIR/$f" "$qdir/" && log "  quarantined $f"
    done
    awk 'NF>=6 && $6=="b"' "$MANIFEST" > "$MANIFEST.new" 2>/dev/null && mv "$MANIFEST.new" "$MANIFEST"
    log "manifest is now:"; sed 's/^/  /' "$MANIFEST" >&2 2>/dev/null || true
}

# ── crash-loop detection ────────────────────────────────────────────────
attempts=0
if [ -f "$MARKER" ]; then
    attempts=$(cat "$MARKER" 2>/dev/null || echo 0)
    case "$attempts" in ''|*[!0-9]*) attempts=0 ;; esac
    log "previous boot did NOT reach 'ready' (consecutive pre-ready deaths: $attempts)."
    if [ "$attempts" -ge "$MAX_HEAL" ]; then
        log "giving up self-heal after $attempts attempts -- base RDB itself may be unloadable."
        log "starting anyway so the crash is VISIBLE; no data touched."
    elif [ "$attempts" -ge "$QUARANTINE_AFTER" ] && incr_present; then
        quarantine_incr
    elif [ "$attempts" -ge "$QUARANTINE_AFTER" ]; then
        log "no incremental AOF to quarantine -- the base load itself is failing. No data touched."
    else
        log "one pre-ready death so far; could be a manual stop mid-load. Retrying before healing."
    fi
fi

# ── arm the detector for THIS boot ──────────────────────────────────────
echo $((attempts + 1)) > "$MARKER" 2>/dev/null || true

# ── clear the marker once redis is genuinely ready (background one-shot) ──
# Only a real PONG counts; during load redis answers -LOADING, not PONG.
(
    while :; do
        if [ "$(redis-cli ping 2>/dev/null)" = "PONG" ]; then
            rm -f "$MARKER"
            echo "[falkordb-entrypoint] redis ready -- cleared crash marker (self-heal idle)." >&2
            exit 0
        fi
        sleep 2
    done
) &

# ── normal path: hand off to the real FalkorDB launcher, args/env untouched ─
exec "$RUN" "$@"
