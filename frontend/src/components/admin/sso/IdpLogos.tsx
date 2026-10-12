/**
 * Identity-provider marks, inline.
 *
 * Follows ``ProviderLogos.tsx`` (the data-source equivalent): hand-drawn
 * SVG in brand colours, no network. That is not only a performance
 * choice — the app serves ``img-src 'self' data: blob:``, so a remote logo
 * URL is blocked by the browser and renders as a broken image. Bundled
 * marks are same-origin and always draw.
 *
 * Simplified geometric interpretations for UI identification at 20-40px,
 * not exact reproductions.
 */
import type { ComponentType } from 'react'

interface LogoProps {
    className?: string
}

/** Microsoft's four-square mark. */
export const EntraLogo: React.FC<LogoProps> = ({ className }) => (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
        <rect x="2" y="2" width="9" height="9" fill="#F25022" />
        <rect x="13" y="2" width="9" height="9" fill="#7FBA00" />
        <rect x="2" y="13" width="9" height="9" fill="#00A4EF" />
        <rect x="13" y="13" width="9" height="9" fill="#FFB900" />
    </svg>
)

/** Okta's ring. */
export const OktaLogo: React.FC<LogoProps> = ({ className }) => (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
        <circle cx="12" cy="12" r="10" fill="#007DC1" />
        <circle cx="12" cy="12" r="4.2" fill="#fff" />
    </svg>
)

/** Auth0's stylised shield/A. */
export const Auth0Logo: React.FC<LogoProps> = ({ className }) => (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
        <path d="M12 1.5 21 7v6.2c0 4.2-3.6 7.8-9 9.3-5.4-1.5-9-5.1-9-9.3V7z"
              fill="#EB5424" />
        <path d="M12 6.4l1.9 5.6h-3.8z" fill="#fff" />
        <path d="M8.4 17.2l1.5-4.4 1.6 1.2zM15.6 17.2l-1.5-4.4-1.6 1.2z"
              fill="#fff" opacity=".85" />
    </svg>
)

/** Keycloak's keyed hexagon. */
export const KeycloakLogo: React.FC<LogoProps> = ({ className }) => (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
        <path d="M7 3h10l5 9-5 9H7l-5-9z" fill="#008AAA" />
        <circle cx="10.5" cy="10.5" r="2.6" fill="#fff" />
        <path d="M12.4 12.1l4.2 4.2-1.5 1.5-4.2-4.2z" fill="#fff" />
    </svg>
)

/** Google's G, in the four brand colours. */
export const GoogleLogo: React.FC<LogoProps> = ({ className }) => (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
        <path d="M21.6 12.2c0-.7-.06-1.4-.18-2.05H12v3.9h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.75 3-4.33 3-7.35z"
              fill="#4285F4" />
        <path d="M12 22c2.7 0 4.97-.9 6.62-2.43l-3.2-2.5c-.9.6-2.05.95-3.42.95-2.63 0-4.85-1.77-5.65-4.15H3.05v2.6A10 10 0 0 0 12 22z"
              fill="#34A853" />
        <path d="M6.35 13.87a6 6 0 0 1 0-3.83v-2.6H3.05a10 10 0 0 0 0 9.03z"
              fill="#FBBC05" />
        <path d="M12 5.98c1.47 0 2.8.5 3.84 1.5l2.84-2.84C16.96 2.99 14.7 2 12 2A10 10 0 0 0 3.05 7.44l3.3 2.6C7.15 7.75 9.37 5.98 12 5.98z"
              fill="#EA4335" />
    </svg>
)

/** AD FS — Microsoft blue, federation arrows. */
export const AdfsLogo: React.FC<LogoProps> = ({ className }) => (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
        <circle cx="6" cy="12" r="3" fill="#0078D4" />
        <circle cx="18" cy="6.5" r="2.6" fill="#50B0E9" />
        <circle cx="18" cy="17.5" r="2.6" fill="#50B0E9" />
        <path d="M8.6 10.8l6.9-3.2M8.6 13.2l6.9 3.2" stroke="#0078D4"
              strokeWidth="1.6" strokeLinecap="round" />
    </svg>
)

/** Generic OIDC — the standard's key motif. */
export const OidcLogo: React.FC<LogoProps> = ({ className }) => (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
        <ellipse cx="10" cy="12" rx="7.5" ry="5.5" fill="none"
                 stroke="currentColor" strokeWidth="1.7" opacity=".55" />
        <path d="M16 5.5v13" stroke="currentColor" strokeWidth="1.7"
              strokeLinecap="round" />
        <path d="M16 8.6l3.6-1.6" stroke="currentColor" strokeWidth="1.7"
              strokeLinecap="round" />
    </svg>
)

/** Generic SAML — an assertion passing between two parties. */
export const SamlLogo: React.FC<LogoProps> = ({ className }) => (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
        <rect x="2" y="7" width="7" height="10" rx="1.4" fill="none"
              stroke="currentColor" strokeWidth="1.6" opacity=".7" />
        <rect x="15" y="7" width="7" height="10" rx="1.4" fill="none"
              stroke="currentColor" strokeWidth="1.6" opacity=".7" />
        <path d="M9.5 12h5" stroke="currentColor" strokeWidth="1.6"
              strokeLinecap="round" />
        <path d="M12.8 10.3L14.9 12l-2.1 1.7" fill="none" stroke="currentColor"
              strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
)

/** Corporate portal — a building, i.e. "your own thing". */
export const PortalLogo: React.FC<LogoProps> = ({ className }) => (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
        <path d="M4 20V8.5L12 4l8 4.5V20z" fill="none" stroke="currentColor"
              strokeWidth="1.6" strokeLinejoin="round" opacity=".75" />
        <rect x="10" y="13" width="4" height="7" fill="currentColor" opacity=".6" />
        <rect x="6.5" y="10.5" width="2.4" height="2.4" fill="currentColor" opacity=".45" />
        <rect x="15.1" y="10.5" width="2.4" height="2.4" fill="currentColor" opacity=".45" />
    </svg>
)

/** Two systems and a call between them — the whole shape of the
 *  back-channel kind, and deliberately not the portal mark: this one
 *  fetches the identity rather than being handed it. */
export const GatewayLogo: React.FC<LogoProps> = ({ className }) => (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
        <rect x="2" y="7" width="7" height="10" rx="1.5" fill="none"
              stroke="currentColor" strokeWidth="1.6" opacity=".75" />
        <rect x="15" y="7" width="7" height="10" rx="1.5" fill="none"
              stroke="currentColor" strokeWidth="1.6" opacity=".75" />
        <path d="M9.5 10.5h5M14.5 10.5l-1.6-1.4M14.5 10.5l-1.6 1.4"
              fill="none" stroke="currentColor" strokeWidth="1.5"
              strokeLinecap="round" strokeLinejoin="round" opacity=".6" />
        <path d="M14.5 13.5h-5M9.5 13.5l1.6-1.4M9.5 13.5l1.6 1.4"
              fill="none" stroke="currentColor" strokeWidth="1.5"
              strokeLinecap="round" strokeLinejoin="round" opacity=".45" />
    </svg>
)

/** Preset id → mark. Keys match ``vendorPresets.ts``. */
export const IDP_LOGOS: Record<string, ComponentType<LogoProps>> = {
    entra: EntraLogo,
    okta: OktaLogo,
    auth0: Auth0Logo,
    keycloak: KeycloakLogo,
    google: GoogleLogo,
    adfs: AdfsLogo,
    oidc: OidcLogo,
    saml2: SamlLogo,
    custom_profile: PortalLogo,
    backchannel: GatewayLogo,
}

/** The mark for a preset id, falling back by kind so an unknown id still
 *  renders something meaningful rather than a hole in the grid. */
export function logoFor(
    presetId: string | undefined, kind?: string,
): ComponentType<LogoProps> {
    if (presetId && IDP_LOGOS[presetId]) return IDP_LOGOS[presetId]
    if (kind === 'saml2') return SamlLogo
    if (kind === 'custom_profile') return PortalLogo
    if (kind === 'backchannel') return GatewayLogo
    return OidcLogo
}
