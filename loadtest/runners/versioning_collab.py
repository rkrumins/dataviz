"""Collaboration runner: people editing drafts together while the rest read canvases.

Used by ``make smoke-versioning-collab``. ``SYNODIC_COLLAB_EDITORS`` users edit
(``CollabEditorTasks``); every user beyond them reads (``CollabReaderTasks``). See
``scenarios/versioning_collab.py`` for what each does and the knobs.
"""
from __future__ import annotations

import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from locust import HttpUser, between  # noqa: E402

from config import SETTINGS  # noqa: E402
from lib.auth import authenticate  # noqa: E402
from lib.data import discover, IdPool  # noqa: E402
from scenarios.versioning_collab import EDITORS, CollabEditorTasks, CollabReaderTasks  # noqa: E402


class CollabEditorUser(HttpUser):
    host = SETTINGS.host
    wait_time = between(SETTINGS.think_min, SETTINGS.think_max)
    fixed_count = EDITORS
    tasks = {CollabEditorTasks: 1}
    id_pool: IdPool

    def on_start(self) -> None:
        authenticate(self.client)
        self.id_pool = discover(self.client)


class CollabReaderUser(HttpUser):
    host = SETTINGS.host
    wait_time = between(SETTINGS.think_min, SETTINGS.think_max)
    tasks = {CollabReaderTasks: 1}
    id_pool: IdPool

    def on_start(self) -> None:
        authenticate(self.client)
        self.id_pool = discover(self.client)
