/**
 * A service account is a user row nobody signs in as, told apart by its id —
 * the backend's `backend/common/service_accounts.py` makes every one `svc_…`.
 */
export function isServiceAccountId(id: string | null | undefined): boolean {
    return !!id && id.startsWith('svc_')
}

/** Where an administrator looks after one: the Service accounts page, opened on it. */
export const serviceAccountHref = (id: string) =>
    `/admin/service-accounts?account=${encodeURIComponent(id)}`
