"""Break-glass: set a password on an account from the command line.

For the one situation the UI cannot cover. Admin → Users can reset
anybody's password, but only for somebody who is already signed in as an
administrator. When the sole System Administrator forgets theirs, that
door is shut from the inside:

  * ``POST /auth/forgot-password`` deliberately mints no token — it flags
    the account and tells the person to contact their administrator,
    which in this case is themselves.
  * The startup bootstrap only creates an admin when the user table is
    empty, so restarting does not help.

Run it on the host, with database access — which is the authorisation
model here, and the reason there is no HTTP equivalent.

    python -m backend.scripts.reset_admin_password --email you@example.com

The password is prompted for, never taken as an argument: arguments end
up in shell history, in ``ps`` output, and in CI logs.

Also clears any forced-rotation flag and signs every existing session
out, because the reason to reach for this script is usually that you are
not certain who else is holding one.
"""
from __future__ import annotations

import argparse
import asyncio
import getpass
import sys


async def _reset(email: str, password: str) -> int:
    from backend.app.db.engine import get_async_session, init_db, close_db
    from backend.app.db.repositories import user_repo
    from backend.auth_service.core.password import hash_password

    await init_db()
    try:
        async with get_async_session() as session:
            user = await user_repo.get_user_by_email(session, email.strip().lower())
            if user is None:
                print(f"No account found for {email!r}.", file=sys.stderr)
                return 1
            if user.deleted_at is not None:
                print(f"Account {email!r} is deleted.", file=sys.stderr)
                return 1

            await user_repo.update_password(
                session, user.id, hash_password(password),
            )
            # update_password already clears the forced-rotation flag and
            # any pending reset token. What it does not do is end the
            # sessions that are already out there.
            cutoff = await user_repo.revoke_sessions_from_now(session, user.id)
            await user_repo.create_outbox_event(
                session,
                event_type="user.password_reset_by_admin",
                payload={
                    "user_id": user.id,
                    "reset_by": "break_glass_cli",
                    "via": "cli",
                },
                aggregate_type="user",
                aggregate_id=user.id,
            )

        if user.status != "active":
            print(
                f"Note: the account is {user.status!r}, so the new password "
                f"will not sign in until it is activated.",
            )
        print(f"Password set for {email}. Sessions revoked as of {cutoff}.")
        return 0
    finally:
        await close_db()


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="reset_admin_password",
        description="Set a password on an account directly, for lockout recovery.",
    )
    # Required, with no default: this script exists for an emergency, and
    # an emergency tool that guesses which account you meant is worse
    # than one that asks.
    parser.add_argument(
        "--email", required=True, help="Email address of the account to reset.",
    )
    args = parser.parse_args()

    password = getpass.getpass("New password: ")
    if not password:
        print("Aborted: no password entered.", file=sys.stderr)
        return 1
    if password != getpass.getpass("Confirm new password: "):
        print("Aborted: the two entries did not match.", file=sys.stderr)
        return 1
    # Matches the floor the API enforces. The zxcvbn check is not run
    # here on purpose — a locked-out operator picking something the
    # library dislikes should not be blocked from getting back in, and
    # they can change it again from the account page once they are.
    if len(password) < 8:
        print("Aborted: use at least 8 characters.", file=sys.stderr)
        return 1

    return asyncio.run(_reset(args.email, password))


if __name__ == "__main__":
    raise SystemExit(main())
