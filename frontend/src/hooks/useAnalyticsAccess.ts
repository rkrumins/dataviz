/**
 * May this person open Analytics, and how much of it will they see?
 *
 * Two independent doors, and the catalogue can only describe one of them:
 *
 *   * **Permission** — `system:admin`, `system:org-admin` or
 *     `system:audit:read`. Always grants the full, unredacted section,
 *     whatever the flag says. Taking an administrator's own dashboard away
 *     with a switch labelled "for everyone" would make it a foot-gun.
 *   * **`analyticsPublicEnabled`** — opens a REDACTED version to everyone
 *     else. A feature flag is not a permission, and `NavPermissionSpec` has
 *     no way to express "or the flag is on", so the OR lives here rather than
 *     being bent into the catalogue.
 *
 * One hook, used by both the sidebar item and the route guard, so a nav entry
 * can never appear for someone the route will then refuse — the failure this
 * exists to prevent.
 *
 * The flag fails CLOSED here, matching its declared `security` posture on the
 * server (`config/feature_wiring.py`). While flags are still loading a
 * non-privileged person is treated as not having access: showing a nav item
 * and then withdrawing it reads as a glitch, whereas showing it a moment late
 * reads as loading.
 */
import { useFeature, useFeaturesStore } from '@/store/features'
import { useNavPermission } from '@/store/auth'
import { useSidebarSpec } from '@/store/navCatalogue'

export const ANALYTICS_PUBLIC_FLAG = 'analyticsPublicEnabled'

/** How much a non-privileged reader is shown. Mirrors `PrivacyMode` server-side. */
export const ANALYTICS_PRIVACY_FLAG = 'analyticsPrivacyMode'

/** Whether Analytics reports on workspaces the reader cannot open. */
export const ANALYTICS_WORKSPACE_FLAG = 'analyticsWorkspaceVisibility'

export interface AnalyticsAccess {
    /** Show the nav item / allow the route. */
    allowed: boolean
    /** Holds one of the privileged permissions — sees the full document. */
    privileged: boolean
    /** In only because the flag is on — the server will redact their payload. */
    viaPublicFlag: boolean
    /** Flags have not resolved yet; a non-privileged answer is provisional. */
    pending: boolean
}

export function useAnalyticsAccess(): AnalyticsAccess {
    const privileged = useNavPermission(useSidebarSpec('analytics'))
    const publicEnabled = useFeature(ANALYTICS_PUBLIC_FLAG)
    const flagsLoaded = useFeaturesStore((s) => s.loaded)

    return {
        allowed: privileged || publicEnabled,
        privileged,
        viaPublicFlag: !privileged && publicEnabled,
        pending: !privileged && !flagsLoaded,
    }
}
