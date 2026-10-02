# The load generator, as its own image.
#
# Deliberately NOT built from the backend image. The harness has one
# dependency (locust) and no backend imports — see `requirements.txt` and the
# README's "decoupled" note — and a generator that shares the application's
# image shares its Python, its libraries and its CVE surface, which is a poor
# trade for a thing whose only job is to send HTTP.
#
# Built for the same architecture as the cluster it runs in. On a mixed-arch
# node pool, build with buildx and push a manifest list, or the workers will
# land on nodes they cannot start on and the run will silently be smaller than
# you asked for.
FROM python:3.11-slim

# gevent (locust's concurrency model) is wheels-only on slim for the common
# arches; no build toolchain needed. Kept explicit so a base-image change that
# breaks that assumption fails here rather than at pod start.
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /loadtest

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Non-root: this pod talks to the app over HTTP and writes CSVs. It has no
# reason to be able to do anything else.
RUN useradd --create-home --uid 10001 locustuser \
    && mkdir -p /results \
    && chown -R locustuser:locustuser /loadtest /results
USER 10001

# Results land here; mount a volume over it to keep them past the pod.
VOLUME ["/results"]

# No ENTRYPOINT that hides the command: the manifests pass the full locust
# invocation so what ran is visible in `kubectl get pod -o yaml` rather than
# baked into a layer nobody reads.
CMD ["locust", "--help"]
