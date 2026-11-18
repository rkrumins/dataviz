"""Views made from a query, kept in step with their data.

Such a view is an ordinary curated Context View. Its definition is
``config.membership`` (``backend/common/models/view_membership.py``): the queries
its members come from, how they are laid out, what is kept out and where people
put things. Its members — up to ``LIVE_VIEW_MAX_MEMBERS`` — are rows the server
writes and owns (``view_members``, an epoch of its answer at a time), never entries
of its config; the config holds only the entries people place themselves ("Always
include"), which the server never touches.

* ``layouts``   — the layers a new view starts with, for each layout kind;
* ``plan``      — a page of members → where each one is placed (pure, deterministic);
* ``ownership`` — keeping the members the server's through every layout write;
* ``pipeline``  — resolve (member sets), place a page at a time and apply, fenced
  against concurrent writers.
"""
