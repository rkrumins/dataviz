/**
 * A service account is a user row nobody signs in as, told apart by its id —
 * the backend's `backend/common/service_accounts.py` makes every one `svc_…`.
 */
export function isServiceAccountId(id: string | null | undefined): boolean {
    return !!id && id.startsWith('svc_')
}

/** Its own page, where its managers and the administrators of service accounts look after it. */
export const serviceAccountHref = (id: string) => `/service-accounts/${encodeURIComponent(id)}`
