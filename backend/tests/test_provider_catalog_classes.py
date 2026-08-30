"""Provider catalog classes -- every registered descriptor's
``provider_class_path`` resolves to a class that honours the contract, and
importing the catalog module pulls in neither a graph driver nor
``backend.app``.

``KNOWN_UNINSTANTIABLE`` is DataHub only: ``DataHubGraphQLProvider`` is
missing 6 abstract members (verified directly -- see the class-level
assertion below) and its file is not edited this PR.
"""
import inspect
import subprocess
import sys
from pathlib import Path

import backend.app.providers.falkordb  # noqa: F401  (registers "falkordb" -- see catalog/__init__.py docstring)
from backend.common.providers.catalog import PROVIDER_CATALOG, registered_type_ids

KNOWN_UNINSTANTIABLE = {"datahub"}
_REPO_ROOT = str(Path(__file__).resolve().parents[2])


def _resolve(provider_class_path: str):
    module_path, _, class_name = provider_class_path.partition(":")
    module = __import__(module_path, fromlist=[class_name])
    return getattr(module, class_name)


def _run_fresh_import(body: str) -> str:
    """Run ``body`` in a fresh interpreter with the repo root on sys.path,
    and return its stdout. Subprocess, not just a sys.modules check in this
    process, because this process may already have falkordb/neo4j/spanner/
    backend.app imported by an earlier test."""
    script = f"import sys; sys.path.insert(0, {_REPO_ROOT!r})\n{body}"
    result = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    return result.stdout


def test_registered_types_are_exactly_the_expected_four():
    assert set(registered_type_ids()) == {"falkordb", "neo4j", "datahub", "spanner"}


def test_provider_class_path_resolves_for_every_descriptor():
    for type_id, descriptor in PROVIDER_CATALOG.items():
        cls = _resolve(descriptor.provider_class_path)
        assert cls.__name__, type_id


def test_abstractmethods_empty_except_known_exception():
    for type_id, descriptor in PROVIDER_CATALOG.items():
        cls = _resolve(descriptor.provider_class_path)
        if type_id in KNOWN_UNINSTANTIABLE:
            assert cls.__abstractmethods__, (
                f"{type_id} is listed in KNOWN_UNINSTANTIABLE but {cls.__name__} "
                "has no remaining abstract methods -- the defect it names is fixed; "
                "drop it from KNOWN_UNINSTANTIABLE"
            )
        else:
            assert not cls.__abstractmethods__, (
                f"{type_id}: {cls.__name__} has unimplemented abstract methods "
                f"{sorted(cls.__abstractmethods__)}"
            )


def test_preflight_is_a_coroutine_on_every_registered_class():
    """preflight is required by convention, never defaulted on the ABC
    (manager.py's probe path calls it unconditionally) -- this is what
    enforces that convention now that construction runs through the
    catalog for every type, including the one (DataHub) that can't be
    instantiated to check at the instance level."""
    for type_id, descriptor in PROVIDER_CATALOG.items():
        cls = _resolve(descriptor.provider_class_path)
        preflight = getattr(cls, "preflight", None)
        assert inspect.iscoroutinefunction(preflight), type_id


def test_importing_catalog_does_not_import_graph_drivers():
    """The catalog is imported by workers with no graph driver installed
    (T4). Driver imports stay inside build(), reached only when a live
    instance is actually constructed."""
    stdout = _run_fresh_import(
        "import backend.common.providers.catalog\n"
        "drivers = [m for m in ('falkordb', 'neo4j', 'google.cloud.spanner') if m in sys.modules]\n"
        "print('DRIVERS=' + ','.join(drivers))\n"
    )
    line = next(l for l in stdout.splitlines() if l.startswith("DRIVERS="))
    drivers = set(line[len("DRIVERS="):].split(",")) - {""}
    assert drivers == set(), f"catalog import pulled in driver module(s): {drivers!r}"


def test_importing_catalog_does_not_import_backend_app():
    """The defect this test guards: backend/common/providers/ (the kernel
    test_falkordb_kernel_purity.py protects) cannot import backend.app --
    module-level or inside build(). Three of four types build their
    concrete class from backend.graph.adapters, which this kernel may
    reference; FalkorDB cannot (its class lives under backend.app), so it
    registers itself from there instead and is absent from PROVIDER_CATALOG
    until something imports it -- this asserts the catalog import alone
    proves that absence, end to end, not just via the static AST guard."""
    stdout = _run_fresh_import(
        "import backend.common.providers.catalog as catalog\n"
        "app_modules = [m for m in sys.modules if m == 'backend.app' or m.startswith('backend.app.')]\n"
        "print('APP_MODULES=' + ','.join(sorted(app_modules)))\n"
        "print('REGISTERED=' + ','.join(sorted(catalog.registered_type_ids())))\n"
    )
    fields = dict(line.split("=", 1) for line in stdout.splitlines() if "=" in line)
    app_modules = set(fields["APP_MODULES"].split(",")) - {""}
    registered = set(fields["REGISTERED"].split(",")) - {""}
    assert app_modules == set(), f"catalog import pulled in backend.app module(s): {app_modules!r}"
    assert registered == {"neo4j", "datahub", "spanner"}, (
        f"importing the catalog alone should register exactly the three kernel-safe "
        f"types, got {registered!r} -- if falkordb is now in this set, something "
        "reintroduced a backend.app import into the kernel"
    )


def test_importing_manager_registers_falkordb():
    """PR 2 T-F: ProviderManager._create_provider_instance now delegates to
    create_provider_instance(spec) instead of importing FalkorDBProvider
    itself inline, so nothing about the dispatch method forces "falkordb" to
    be registered anymore. Importing backend.app.providers.manager alone
    must still register it (manager.py's eager `from
    backend.app.providers.falkordb import catalog_descriptor`) -- without
    that import, the FIRST "falkordb" dispatch in a fresh process raises
    Unknown provider_type: 'falkordb'. Regression pin for exactly that bug."""
    stdout = _run_fresh_import(
        "import backend.app.providers.manager\n"
        "from backend.common.providers.catalog import descriptor_for\n"
        "print('REGISTERED=' + str(descriptor_for('falkordb') is not None))\n"
    )
    line = next(l for l in stdout.splitlines() if l.startswith("REGISTERED="))
    assert line == "REGISTERED=True"


def test_importing_provider_registry_registers_falkordb():
    """Same guarantee for the other dispatcher (backend.app.registry.
    provider_registry) -- checked as its own fresh-process import, not
    layered onto the test above, so removing either module's own eager
    import is caught even though provider_registry.py also imports
    manager.py (for an unrelated re-export) and so would otherwise get this
    for free."""
    stdout = _run_fresh_import(
        "import backend.app.registry.provider_registry\n"
        "from backend.common.providers.catalog import descriptor_for\n"
        "print('REGISTERED=' + str(descriptor_for('falkordb') is not None))\n"
    )
    line = next(l for l in stdout.splitlines() if l.startswith("REGISTERED="))
    assert line == "REGISTERED=True"
