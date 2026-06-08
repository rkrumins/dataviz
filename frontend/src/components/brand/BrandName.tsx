/**
 * BrandName — the deployment's display name.
 *
 * Renders the configured app name (or the compact ``shortName`` variant).
 * Replaces the hardcoded ``Nexus<span>Lineage</span>`` markup that used to
 * live in TopBar / the auth pages so a single branding change updates the
 * name everywhere. The old two-tone split is dropped intentionally: an
 * arbitrary client name shouldn't be force-split on a fixed boundary.
 */
import { useBrand } from '@/store/branding'

interface BrandNameProps {
    /** Use the compact ``shortName`` (header) instead of the full name. */
    short?: boolean
    className?: string
}

export function BrandName({ short = false, className }: BrandNameProps) {
    const { appName, shortName } = useBrand()
    return <span className={className}>{short ? shortName : appName}</span>
}
