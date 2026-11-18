"""Member sets: everything a membership spec names, resolved in full, a step at a time.

A Narrow (``view_membership``) answers inside one request, up to a cap. A member set
answers the same question completely, however large — so it outlives any request:

* ``walk`` — the lineage walk, one closure step at a time; the Narrow takes it too;
* ``store`` — a set's rows, and the lease and fence every step writes through;
* ``stepper`` — moves a set on, stage by stage, a step per short transaction;
* ``download`` — streams a set's rows (and edges) in the order they joined;
* ``sweeper`` — expires sets nobody moves on or has read for a day, and deletes them.

The routes are ``api/v1/endpoints/graph_member_sets.py``; the contract is
``common/models/member_set.py``.
"""
