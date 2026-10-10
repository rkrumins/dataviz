"""The platform activity ledger: who did what, where, when and why.

Capture rides the transactional outbox (``outbox_events``); the relay projects
each event into ``auth_audit_log``, whose promoted columns are what every
activity read filters on. See ``catalogue`` for how an event is classified,
``recorder`` for how a new operation is captured, and ``names`` for how ids
are named at read time.

Modules here import only the database layer, ``backend.app.common`` and the
standard library, so the aggregation control plane can load them without the
web tier's auth configuration.
"""
