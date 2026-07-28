"""Creating accounts directly, rather than handing out a link.

The rules that matter here are the ones shared with the invite path: an
account an admin types out and an account somebody redeems a link for are
the same account, so a ceiling that binds one has to bind the other or the
stricter path is merely the slower one.
"""
import pytest

from backend.auth_service.core.password import is_password_set


pytestmark = pytest.mark.asyncio


async def _post(client, body, path="/api/v1/admin/users"):
    return await client.post(path, json=body)


BASE = {"email": "grace@company.com", "firstName": "Grace", "lastName": "Hopper"}


class TestCreateOne:
    async def test_creates_an_active_account_recorded_as_admin_created(
        self, test_client, db_session,
    ):
        r = await _post(test_client, BASE)
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["email"] == "grace@company.com"
        assert body["status"] == "active"

        from backend.app.db.repositories import user_repo
        user = await user_repo.get_user_by_email(db_session, "grace@company.com")
        assert user is not None
        # The column has carried this value since Phase 4 and nothing set
        # it until now; a create that records 'local_signup' makes the
        # provenance column useless for the one question it answers.
        assert user.signup_source == "admin_created"

    async def test_setup_link_leaves_no_usable_password_and_returns_a_token(
        self, test_client, db_session,
    ):
        r = await _post(test_client, BASE)
        assert r.status_code == 201
        assert r.json()["setupToken"], "the admin has nothing to send without this"

        from backend.app.db.repositories import user_repo
        user = await user_repo.get_user_by_email(db_session, "grace@company.com")
        # Nobody — including the admin who made the account — knows a
        # password for it. That is the point of this mode.
        assert not is_password_set(user.password_hash)

    async def test_admin_set_password_is_usable_and_returns_no_token(
        self, test_client, db_session,
    ):
        r = await _post(test_client, {
            **BASE, "credential": "password", "password": "Str0ng-Passw0rd!x",
        })
        assert r.status_code == 201, r.text
        assert r.json()["setupToken"] is None

        from backend.app.db.repositories import user_repo
        user = await user_repo.get_user_by_email(db_session, "grace@company.com")
        assert is_password_set(user.password_hash)

    async def test_sso_only_leaves_no_password_and_no_token(
        self, test_client, db_session,
    ):
        r = await _post(test_client, {**BASE, "credential": "sso_only"})
        assert r.status_code == 201
        assert r.json()["setupToken"] is None

        from backend.app.db.repositories import user_repo
        user = await user_repo.get_user_by_email(db_session, "grace@company.com")
        assert not is_password_set(user.password_hash)

    async def test_a_weak_password_is_refused(self, test_client):
        r = await _post(test_client, {
            **BASE, "credential": "password", "password": "abc",
        })
        # 422, not 400: the strength check is the same helper signup
        # uses, and an admin-set password must clear the same bar as one
        # the user picks themselves.
        assert r.status_code == 422

    async def test_password_mode_without_a_password_is_refused(self, test_client):
        r = await _post(test_client, {**BASE, "credential": "password"})
        assert r.status_code == 400

    async def test_an_unknown_credential_mode_is_refused(self, test_client):
        r = await _post(test_client, {**BASE, "credential": "telepathy"})
        assert r.status_code == 400

    async def test_a_malformed_address_is_refused(self, test_client):
        r = await _post(test_client, {**BASE, "email": "not-an-address"})
        assert r.status_code == 400

    async def test_a_duplicate_address_conflicts(self, test_client):
        assert (await _post(test_client, BASE)).status_code == 201
        again = await _post(test_client, BASE)
        assert again.status_code == 409

    async def test_pending_is_available_for_an_account_not_yet_wanted(
        self, test_client,
    ):
        r = await _post(test_client, {**BASE, "activate": False})
        assert r.status_code == 201
        assert r.json()["status"] == "pending"

    async def test_an_unknown_role_is_refused_before_the_account_exists(
        self, test_client, db_session,
    ):
        r = await _post(test_client, {**BASE, "role": "wizard_supreme"})
        assert r.status_code == 400

        from backend.app.db.repositories import user_repo
        assert await user_repo.get_user_by_email(db_session, "grace@company.com") is None


class TestBulk:
    async def test_creates_every_valid_row_and_reports_each(self, test_client):
        r = await _post(test_client, {
            "users": [
                {"email": "a@company.com", "firstName": "Ada", "lastName": "L"},
                {"email": "b@company.com"},
                {"email": "nope"},
            ],
        }, path="/api/v1/admin/users/bulk")
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["created"] == 2
        assert body["skipped"] == 1
        outcomes = {x["email"]: x["outcome"] for x in body["results"]}
        assert outcomes["a@company.com"] == "created"
        assert outcomes["b@company.com"] == "created"
        assert outcomes["nope"] == "invalid_email"

    async def test_a_row_without_a_name_gets_one_derived_from_the_address(
        self, test_client, db_session,
    ):
        r = await _post(test_client, {
            "users": [{"email": "grace.hopper@company.com"}],
        }, path="/api/v1/admin/users/bulk")
        assert r.status_code == 201

        from backend.app.db.repositories import user_repo
        user = await user_repo.get_user_by_email(db_session, "grace.hopper@company.com")
        # Not an empty string (the schema forbids it) and not the raw
        # address (which reads as a bug in every list that shows a name).
        assert user.first_name == "Grace"
        assert user.last_name == "Hopper"

    async def test_one_existing_address_does_not_cost_the_others(self, test_client):
        await _post(test_client, {**BASE, "email": "taken@company.com"})

        r = await _post(test_client, {
            "users": [
                {"email": "taken@company.com"},
                {"email": "fresh@company.com"},
            ],
        }, path="/api/v1/admin/users/bulk")
        assert r.status_code == 201
        body = r.json()
        assert body["created"] == 1
        outcomes = {x["email"]: x["outcome"] for x in body["results"]}
        assert outcomes["taken@company.com"] == "already_a_user"
        assert outcomes["fresh@company.com"] == "created"

    async def test_a_repeated_address_is_created_once(self, test_client):
        r = await _post(test_client, {
            "users": [{"email": "dup@company.com"}, {"email": "dup@company.com"}],
        }, path="/api/v1/admin/users/bulk")
        assert r.status_code == 201
        body = r.json()
        assert body["created"] == 1
        assert [x["outcome"] for x in body["results"]] == ["created", "duplicate"]

    async def test_a_shared_password_across_a_batch_is_refused(self, test_client):
        r = await _post(test_client, {
            "users": [{"email": "a@company.com"}],
            "credential": "password",
        }, path="/api/v1/admin/users/bulk")
        assert r.status_code == 400
        # A password that twenty people know is not a credential.
        assert "not a credential" in r.json()["detail"].lower()

    async def test_every_created_row_carries_its_own_setup_token(self, test_client):
        r = await _post(test_client, {
            "users": [{"email": "a@company.com"}, {"email": "b@company.com"}],
        }, path="/api/v1/admin/users/bulk")
        tokens = [x["setupToken"] for x in r.json()["results"] if x["outcome"] == "created"]
        assert len(tokens) == 2
        assert all(tokens)
        assert tokens[0] != tokens[1], "one token for two accounts is one account"
