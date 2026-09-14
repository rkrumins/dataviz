# Running the load test in the cluster

Deliberately **not** part of `base/kustomization.yaml`. A load generator does
not belong in every deploy, and one applied by accident is indistinguishable
from an attack. Apply it explicitly, run it, delete it:

```
kubectl apply -k deploy/k8s/loadtest
kubectl -n synodic logs -f deploy/loadtest-master
kubectl delete -k deploy/k8s/loadtest
```

The namespace must already exist — this overlay adds a generator to a running
deployment, it does not stand one up.

## Why the affinity rules are the important part

The failure mode of a cluster-hosted load test is that it measures itself.

* **Workers spread across nodes** (`podAntiAffinity` on the worker's own
  label, `requiredDuringScheduling`). Two workers on one node share that
  node's CPU and one NIC, so the run reports a ceiling that belongs to the
  generator, not to the system. `required`, not `preferred`: a silently
  co-scheduled pair produces a plausible wrong number, which is worse than a
  pod stuck `Pending` and an operator asking why. If they will not schedule,
  the cluster does not have the nodes for the concurrency you asked for —
  which is itself the answer.
* **Workers away from the app and the graph store** (anti-affinity on
  `viz-service`, `falkordb`, `aggregation-worker`). A generator sharing a node
  with the thing it measures steals the CPU it is trying to measure the
  absence of. This one is `preferred`, because on a small cluster "nowhere
  left to schedule" is worse than a little contention — but read the node
  placement before you believe a number from a small cluster.
* **Requests, not just limits.** An unrequested generator gets throttled by
  the kubelet under exactly the load it is meant to produce, and reports the
  throttling as the system being slow.

Check where things actually landed before trusting a result:

```
kubectl -n synodic get pods -o wide -l app.kubernetes.io/part-of=loadtest
kubectl -n synodic get pods -o wide -l app.kubernetes.io/name=viz-service
```

## How a run starts, and how it ends

The master does **not** ramp on the first worker connection. `LOCUST_AUTOSTART`
plus `LOCUST_EXPECT_WORKERS` means it waits for every worker, then starts —
otherwise the early part of the ramp is served by a fraction of the generators
and the run reports a latency knee that is really the harness arriving late.
**Keep `LOCUST_EXPECT_WORKERS` equal to the worker Deployment's `replicas`.**
Set it higher and the run never starts; lower and it starts short-handed.

There is deliberately no `--autoquit`: when `LOCUST_RUN_TIME` expires the
master stays up holding the summary. A master that exited would be restarted
by its Deployment, which would start the entire run again — quietly, against a
system somebody had already begun investigating.

To drive a run by hand instead, set `LOCUST_AUTOSTART=false` and use the web
UI. It is a `ClusterIP` with no ingress on purpose — that UI can start a load
test:

```
kubectl -n synodic port-forward svc/loadtest-master 8089:8089
```

## Sizing

Concurrency is the master's `LOCUST_USERS`, which Locust distributes across
the connected workers — it is not multiplied by the replica count. The number
that matters for correctness is the quotient: `LOCUST_USERS / replicas` is
what each worker process carries, and past a few hundred a worker's own event
loop, not the system under test, sets the pace. Raise `replicas` (and
`LOCUST_EXPECT_WORKERS` with it) before raising users-per-worker.

The default 300 users over 3 workers is 100 each, well inside that. See
`docs/CONCURRENCY_TUNING.md` for what the backend is expected to sustain at a
given concurrency, and check the generator's own CPU before reading a knee as
the system's:

```
kubectl -n synodic top pods -l app.kubernetes.io/name=loadtest-worker
```

## Did the protection hold?

The CSV says the system was fast. It does not say the limits were enforced,
and the cheapest way to be fast is to stop enforcing them — see the protection
gate in [`loadtest/README.md`](../../../loadtest/README.md). The master runs
locust directly rather than `make sweep`, so bracket the run by hand from
anywhere that can reach the pods. Each pod keeps its own registry, so scrape
all of them:

```
export SYNODIC_METRICS_URLS="$(kubectl -n synodic get pods \
  -l app.kubernetes.io/name=viz-service \
  -o jsonpath='{range .items[*]}http://{.status.podIP}:8000/api/v1/metrics {end}')"
python -m lib.protection --before protection.json    # before the ramp
python -m lib.protection --check  protection.json    # after LOCUST_RUN_TIME
```

`METRICS_ENABLED` must be on in the deployment under test, and the pod IPs are
only reachable from inside the cluster — run it from a pod, or port-forward
each one.

## Results

The master writes `--csv /results/run` and `--html /results/run.html`, both
updated during the run. The default volume is an `emptyDir`, which dies with
the pod — fine for reading the summary off the log, useless for keeping it.
For a run you want to keep, either copy it off before deleting:

```
kubectl -n synodic cp "$(kubectl -n synodic get pod \
  -l app.kubernetes.io/name=loadtest-master -o name | cut -d/ -f2)":/results ./results
```

…or swap the volume for a PVC (see the commented block at the bottom of
`master.yaml`, and add the claim to `kustomization.yaml`).
