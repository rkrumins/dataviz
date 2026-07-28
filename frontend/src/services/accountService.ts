/**
 * Account Service — the things you can do to your own account.
 *
 * Separate from `authService`, which owns the pre-session surface
 * (login, signup, the reset flow). These all require a session and all
 * mutate the account behind it.
 */
import { authFetch } from './apiClient'

const USERS_API = '/api/v1/users'

/**
 * Mirrors the backend `UserPublicResponse`.
 *
 * Named `MyProfile` rather than `UserPublicResponse` on purpose:
 * `authService` already exports that name as a back-compat alias for
 * `AuthUser`, which is a different shape (no `displayName`, extra
 * `authProvider`). Two types with one name is a trap worth avoiding.
 */
export interface MyProfile {
    id: string
    email: string
    firstName: string
    lastName: string
    /** Resolved server-side: the chosen name, or first + last. */
    displayName: string
    status: string
    role: string
    createdAt: string
    avatarId: string | null
    mustChangePassword: boolean
    /**
     * Profile fields the identity provider asserted at your last sign-in
     * and re-applies at every one. Render these read-only — a write is
     * refused with a 409, and would revert anyway.
     *
     * Per-field, not per-account: an IdP that releases `given_name` but
     * no `family_name` owns only the first. Empty for local accounts.
     */
    idpManagedFields: string[]
    /** Provider id owning those fields. Join to /me/identities for a name. */
    idpManagedBy: string | null
}

export interface ProfilePatch {
    firstName?: string
    lastName?: string
    /** Empty string clears the override and restores first + last. */
    displayName?: string
    avatarId?: string
}

/** One entry in the account's own security history. */
export interface AccountActivityItem {
    id: string
    eventType: string
    occurredAt: string
    /** True when somebody else did this to the account. */
    byAdmin: boolean
}

export const accountService = {
    getProfile(): Promise<MyProfile> {
        return authFetch<MyProfile>(`${USERS_API}/me`)
    },

    updateProfile(patch: ProfilePatch): Promise<MyProfile> {
        return authFetch<MyProfile>(`${USERS_API}/me`, {
            method: 'PATCH',
            body: JSON.stringify(patch),
        })
    },

    /**
     * Change the password, which signs every session out — this one
     * included. The caller is expected to send the user to /login.
     *
     * `silent403`: a wrong current password comes back as 403, and that
     * is an expected outcome of this form, not an RBAC denial. Without
     * this the global access-denied modal fires with copy about missing
     * permissions.
     */
    changePassword(currentPassword: string, newPassword: string): Promise<{ detail: string }> {
        return authFetch<{ detail: string }>(`${USERS_API}/me/password`, {
            method: 'POST',
            body: JSON.stringify({ currentPassword, newPassword }),
            silent403: true,
        })
    },

    /** Sign out everywhere, including here. */
    revokeAllSessions(): Promise<{ detail: string }> {
        return authFetch<{ detail: string }>(`${USERS_API}/me/sessions/revoke-all`, {
            method: 'POST',
        })
    },

    listActivity(): Promise<AccountActivityItem[]> {
        return authFetch<AccountActivityItem[]>(`${USERS_API}/me/activity`)
    },
}
