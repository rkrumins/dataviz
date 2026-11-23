"""Settings: one store for the values chosen by the platform, a workspace or a graph, with their
history, and one resolver that gives each setting's effective value and where it came from.

* :mod:`.store` — ``setting_values``, ``setting_changes``, ``settings_imports``: reads, an
  all-or-nothing :func:`~.store.apply` checked against each value's version, history, revert.
* :mod:`.snapshot` — each process's copy of the rows, reloaded incrementally when a save moves the
  domain's generation in Redis.
* :mod:`.resolver` — pure: graph → workspace → platform → environment → code default, then the
  platform's limits, caps, derived values and requirements, with the trail and the reasons.
* :mod:`.validate` — what a proposed change set may not do, as ``{key, code, message}``.
* :mod:`.legacy` — where each value lived before, written through for one release, imported once,
  and compared (``python -m backend.app.services.settings legacy-diff [--adopt]``).
* :mod:`.facts` — the live facts the registry's recommendations read.

What a setting IS lives in code: ``backend/app/config/versioned_graph_settings.py``, built from
``backend/app/config/settings_types.py``. Every function here takes the registry as an argument;
:func:`registry` loads the real one when first asked for.
"""
from __future__ import annotations


def registry():
    """The versioned-graph settings registry module (``SETTINGS``, ``BY_KEY``, ``WHY``,
    ``DEPLOYMENT``, ``DOMAIN``, ...), imported when first asked for."""
    from backend.app.config import versioned_graph_settings

    return versioned_graph_settings
