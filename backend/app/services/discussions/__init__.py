"""Questions and conversations about views and data sources (the ``collaboration`` domain).

* ``readers`` — who can open a subject, worked out from role bindings, grants and the
  subject's own rows; who maintains it; its workspace's admins. Repositories only, so
  the control plane's housekeeping can use it without the web tier.
* ``access`` — what the caller of a request may see and do.
* ``routing`` — who a question about a subject goes to.
* ``service`` — asking, replying, answering, closing, reading.
* ``housekeeping`` — the watcher fan-out, reminders, retention and archiving.
"""
