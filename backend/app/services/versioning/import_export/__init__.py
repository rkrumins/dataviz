"""Bulk import/export pipeline for versioned-graph data sources (plan Phases 0–7).

Import = the manual create/edit flow at scale: a file is parsed into a normalized row model,
resolved/diffed, and built onto a draft branch that the user reviews and publishes/PRs through
the existing workflow. Export streams the graph (or a view scope, or an as-of snapshot) to a
downloadable artifact that doubles as a re-importable backup.
"""
