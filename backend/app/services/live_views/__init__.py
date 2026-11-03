"""Views made from a query, kept in step with their data.

Such a view is an ordinary curated Context View. Its definition is
``config.membership`` (``backend/common/models/view_membership.py``): the queries
its members come from, how they are laid out, what is kept out and where people
put things. Its members are assignment entries the server writes and owns
(``assignedBy: "query"``), beside the entries people place themselves ("Always
include"), which the server never touches.

* ``layouts``   — the layers a new view starts with, for each layout kind;
* ``plan``      — resolved sources → the view's entries (pure, deterministic);
* ``ownership`` — keeping server-owned entries intact through every layout write;
* ``pipeline``  — resolve, plan and apply, fenced against concurrent writers.
"""
