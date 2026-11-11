"""``identifier`` on the import routes: what the request may name, and what it takes otherwise.

An import's rows find their entities by ``entity_id`` (the default), ``urn`` or ``prop.<name>``; a
request naming anything else is a 422 that says what it may name. A request naming none takes the platform's
(``GRAPHVER_IMPORT_IDENTIFIER``), unless that is not one an import may name.
"""
import pytest
from fastapi import HTTPException

from backend.app.api.v1.endpoints import versioning as endpoints
from backend.app.services.versioning import config
from backend.app.services.versioning.import_export import identifier as identifiers


@pytest.mark.parametrize("given, expect", [
    (None, ("entity_id", "platform")), ("", ("entity_id", "platform")),
    ("entity_id", ("entity_id", "request")), (" urn ", ("urn", "request")),
    ("prop.external_id", ("prop.external_id", "request")),
])
def test_an_import_takes_the_identifier_it_names_or_the_platforms(given, expect):
    assert identifiers.resolve(given) == expect


@pytest.mark.parametrize("given, says", [
    ("sap_id", "identifier is entity_id, urn or prop.<name>"),
    ("prop.", "needs the property's name"),
    ("prop.urn", "use identifier=urn"),
    ("prop.entity_id", "use identifier=entity_id"),
    ("prop.a\nb", "one line of up to 200 characters"),
])
def test_what_an_import_may_not_name_is_a_422_that_says_what_it_may(given, says):
    with pytest.raises(HTTPException) as caught:
        endpoints._identifier(given)
    assert caught.value.status_code == 422
    assert caught.value.detail["type"] == "invalid_identifier"
    assert says in caught.value.detail["message"], caught.value.detail


def test_the_platforms_default_is_the_operators_when_it_is_one(monkeypatch):
    monkeypatch.setattr(config, "IMPORT_IDENTIFIER", "urn")
    assert identifiers.resolve(None) == ("urn", "platform")
    assert endpoints._identifier(None) == "urn"
    monkeypatch.setattr(config, "IMPORT_IDENTIFIER", "no such thing")
    assert identifiers.resolve(None) == ("entity_id", "platform")
