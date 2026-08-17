"""Gunicorn hooks for Prometheus multiprocess bookkeeping.

Multiprocess mode works by having each worker write its metrics to
memory-mapped files named after its pid, which the scrape endpoint then
aggregates. Nothing in that scheme knows when a worker dies — the files
outlive the process — so the master has to say so, and only the master
is in a position to: it is the one that reaps children.

Without the ``child_exit`` hook below, a recycled worker keeps
contributing to every gauge forever. ``synodic_change_feed_subscribers``
is the one that shows it plainly: it is a ``livesum``, so a worker
holding 40 stream connections when it is killed leaves those 40 in the
fleet total permanently, and the number only ever climbs. Over a week of
rolling restarts the metric that was added to *count* held connections
becomes a count of every connection ever held.

The file is referenced from ``Dockerfile.viz`` via ``--config``. Every
hook is a no-op when ``PROMETHEUS_MULTIPROC_DIR`` is unset, which is the
case for local runs and for any deployment that has not turned metrics
on, so this costs nothing where it does not apply.
"""
from __future__ import annotations

import glob
import os


def _multiproc_dir() -> str | None:
    value = (os.environ.get("PROMETHEUS_MULTIPROC_DIR") or "").strip()
    return value or None


def on_starting(server) -> None:
    """Clear metric files left behind by a previous run.

    Only correct in the master, and only before any worker has forked —
    which is what this hook is. Stale files matter because pids are
    reused: a fresh worker that happens to draw the pid of a dead one
    from the last container would inherit its counter values, and the
    scrape would report a jump that no request caused.

    Assumes this process owns the directory. Two gunicorn masters
    pointed at one path would clear each other's metrics; give each its
    own (in Kubernetes, an ``emptyDir`` per pod).
    """
    directory = _multiproc_dir()
    if directory is None:
        return

    os.makedirs(directory, exist_ok=True)
    stale = glob.glob(os.path.join(directory, "*.db"))
    for path in stale:
        try:
            os.remove(path)
        except OSError as exc:  # noqa: PERF203 - one bad file must not stop the rest
            server.log.warning("could not clear stale metric file %s: %s", path, exc)
    if stale:
        server.log.info("cleared %d stale metric file(s) from %s", len(stale), directory)


def child_exit(server, worker) -> None:
    """Retire a dead worker's live-mode gauges.

    Called in the master when a child is reaped, for every exit path —
    graceful reload, ``--max-requests`` recycling, timeout kill, crash.

    ``mark_process_dead`` removes only the live-mode gauge files
    (``livesum``, ``livemax``, and friends). Counters are deliberately
    left in place: ``synodic_http_requests_total`` counts requests that
    genuinely were served, and deleting them on a restart would make the
    fleet's total go backwards, which is the one thing a counter must
    never do.
    """
    directory = _multiproc_dir()
    if directory is None:
        return

    try:
        from prometheus_client import multiprocess

        multiprocess.mark_process_dead(worker.pid, directory)
    except Exception as exc:  # noqa: BLE001 - never let bookkeeping kill a reload
        server.log.warning("could not retire metrics for pid %s: %s", worker.pid, exc)
