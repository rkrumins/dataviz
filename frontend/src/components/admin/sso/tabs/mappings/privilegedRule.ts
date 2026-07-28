/**
 * The two conditions a platform-admin rule has to meet, checked here
 * instead of at the server.
 *
 * `_validate_provider_assurance` (`idp_group_mapping_repo.py:96`) refuses
 * two things the composer would otherwise let an operator compose in full
 * and submit:
 *
 *   * a platform-admin role mapped from **any connection** — refused
 *     outright, because a wildcard rule would apply to an unverified
 *     connection added next year, and "fine for now" is not a security
 *     property;
 *   * a platform-admin role from a connection below `verified` — an
 *     unsigned corporate-profile row plus an `org_admin` mapping is a
 *     complete compromise assembled from two individually-reasonable admin
 *     actions.
 *
 * Both are knowable from state the composer already holds, so both belong
 * before the click rather than as a 400 with a paragraph of server prose
 * after it. The server keeps its checks — this is a nicer way to arrive at
 * the same answer, not a replacement for it.
 *
 * Narrow by construction: `FORBIDDEN_AUTO_GRANT_ROLES` already strips
 * `super_admin` from the picker, so `org_admin` is the only role that
 * reaches this at all.
 */
import type { IdpProvider } from '@/services/ssoAdminService'
import { PLATFORM_ADMIN_ROLES, type RoleName } from '@/lib/roleNames'

export interface PrivilegedBlock {
    /** Shown against the control that would fix it. */
    message: string
    /** A connection that would satisfy the rule, when one exists. */
    suggestion?: string
}

export function isPlatformAdminRole(roleName: string): boolean {
    return PLATFORM_ADMIN_ROLES.has(roleName as RoleName)
}

/**
 * Why this rule cannot be created, or null when it can.
 *
 * Ordinary roles always return null — a low-assurance connection mapping to
 * a workspace role is a legitimate configuration, and over-blocking it
 * would be its own bug.
 */
export function privilegedRuleBlock(
    roleName: string,
    providerId: string,
    providers: IdpProvider[],
): PrivilegedBlock | null {
    if (!roleName || !isPlatformAdminRole(roleName)) return null

    const verified = providers.filter(p => p.assurance === 'verified')
    const suggestion = verified.length === 1
        ? (verified[0].displayName || verified[0].slug)
        : undefined

    if (!providerId) {
        return {
            message:
                'An admin role has to come from one named connection. Left as ' +
                '“any connection” it would also apply to an unverified one added ' +
                'later, so it is refused outright.',
            suggestion: verified.length
                ? (suggestion
                    ? `Pick ${suggestion}.`
                    : `Pick one of your ${verified.length} verified connections.`)
                : 'No connection is verified yet, so no connection can grant this.',
        }
    }

    const chosen = providers.find(p => p.id === providerId)
    if (chosen && chosen.assurance !== 'verified') {
        return {
            message:
                `${chosen.displayName || chosen.slug} is ` +
                `${chosen.assurance}, so it cannot grant an admin role — we ` +
                'cannot tell a genuine claim from a forged one, and whoever ' +
                'can write its payload would pick their own groups.',
            suggestion: suggestion
                ? `${suggestion} is verified and can.`
                : verified.length
                    ? `${verified.length} of your connections are verified and can.`
                    : 'Sign this connection’s payloads, or grant the role by hand.',
        }
    }

    return null
}
