"""Broker implementations for the job platform.

Each module in this package implements :class:`backend.app.jobs.broker.JobBroker`
for one transport. Workers and consumers depend on the interface;
the implementation is selected by ``JOB_BROKER_BACKEND`` env var via
:func:`backend.app.jobs.get_broker`.

Adding a new broker is a single-file change:

* Implement ``JobBroker``.
* Register it in ``backend/app/jobs/__init__.py``'s factory.
* Run the broker-swappability test suite (same suite, env-var flip).

If the new file diverges from the contract (e.g. needs broker-
specific branches in producer code), the abstraction has leaked
and we fix the interface, not the producers.
"""
