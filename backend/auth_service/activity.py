"""How often "when did this person last use the platform" is written.

Admin → Users shows when each person was last seen and last active. Both
are answered on hot paths — every authenticated request, every product
event — so neither may cost a write per call. Two gates keep it to one row
update per person per ``RESOLUTION_SECONDS``:

* :class:`ActivityGate`, in this process: a dictionary lookup, so the
  common case does no I/O at all.
* The conditional ``UPDATE`` behind it (``user_repo.touch_*``), across
  every process and replica: a row stamped inside the window matches
  nothing and writes nothing.

Lives in ``auth_service`` because the sign-in and session paths use it,
and this package may not import ``backend.app``; the app imports it from
here instead.
"""
from __future__ import annotations

import time

#: The resolution of "last seen" and "last activity". An admin asking when
#: someone was last here does not need it to the second, and five minutes
#: is one write per active person per five minutes, not one per request.
RESOLUTION_SECONDS = 300

#: Past this many entries the gate sheds the ones outside the window, and
#: starts over if that is not enough. Bounds memory by active people, not
#: by everyone who ever signed in.
_MAX_TRACKED = 50_000


class ActivityGate:
    """Opens at most once per person per :data:`RESOLUTION_SECONDS`."""

    def __init__(self) -> None:
        self._last: dict[str, float] = {}

    def opens(self, user_id: str) -> bool:
        now = time.monotonic()
        last = self._last.get(user_id)
        if last is not None and now - last < RESOLUTION_SECONDS:
            return False
        if len(self._last) >= _MAX_TRACKED:
            cutoff = now - RESOLUTION_SECONDS
            for key in [k for k, t in self._last.items() if t < cutoff]:
                del self._last[key]
            if len(self._last) >= _MAX_TRACKED:
                self._last.clear()
        self._last[user_id] = now
        return True

    def clear(self) -> None:
        self._last.clear()
