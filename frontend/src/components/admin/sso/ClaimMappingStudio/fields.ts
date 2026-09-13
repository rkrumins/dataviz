/**
 * The fields ``apply_claim_mapping`` reads, in the order an operator
 * thinks about them.
 *
 * Split from the components so both panes can name a field the same way —
 * the payload pane's "mapped to Email" and the profile pane's "Email" row
 * have to be the same word or the two halves stop referring to each other.
 *
 * ``required`` mirrors the two the backend refuses to resolve without
 * (``claim_mapper.apply_claim_mapping`` raises for external_id and email);
 * everything else degrades to a thinner profile rather than a failed login,
 * which is a difference worth showing rather than a uniform red asterisk.
 */
export interface MappingField {
    key: string
    label: string
    hint: string
    required?: boolean
    /**
     * Mapping this field hands ownership of it to the IdP: the person's own
     * profile renders it read-only, attributed to this connection, and a
     * write is refused with `409 idp_managed_field` — administrators
     * included.
     *
     * Mirrors `identity_provenance.MANAGEABLE_FIELDS`
     * (`backend/common/identity_provenance.py`), which is the authority.
     * Ownership there is decided by whether the field resolves non-blank
     * *after* mapping — which is exactly what this screen controls, so the
     * consequence belongs on this screen.
     */
    managed?: boolean
}

export const FIELDS: MappingField[] = [
    {
        key: 'external_id', label: 'External ID', required: true,
        hint: 'Stable per-user identifier from the IdP. The durable join key — changing it orphans existing logins.',
    },
    {
        key: 'email', label: 'Email', required: true,
        hint: 'Lower-cased before use. Also drives account linking on collision.',
    },
    {
        key: 'email_verified', label: 'Email verified',
        hint: 'Boolean-ish. Strict linking policies refuse to auto-link when this is false.',
    },
    {
        key: 'first_name', label: 'First name', managed: true,
        hint: 'Split out of the full name when both name fields are empty — a guess, so it is not owned by this connection.',
    },
    {
        key: 'last_name', label: 'Last name', managed: true,
        hint: 'Split out of the full name when both name fields are empty — a guess, so it is not owned by this connection.',
    },
    {
        // Deliberately not `managed`, and the asymmetry is the point: this is
        // the name a person can always set for themselves, which is what makes
        // locking the two above tolerable.
        key: 'display_name', label: 'Full / display name',
        hint: 'Used only when first and last name are both empty. Split on the comma for "Doe, Alice", otherwise on the first space.',
    },
    {
        key: 'groups', label: 'Groups',
        hint: 'Feeds the IdP-group → role / internal-group mappings on the Access mapping tab. Accepts a list, or a comma-separated string. Nested keys use dots — entitlements.groups is already a default.',
    },
    {
        key: 'auth_time', label: 'Auth time',
        hint: 'Epoch seconds. Drives the 24h SSO re-authentication ceiling.',
    },
    {
        key: 'avatar_url', label: 'Avatar', managed: true,
        hint: 'A profile-picture URL. Fetched by the server at sign-in and re-served from here — participates only while the connection’s "Map their avatar" toggle is on.',
    },
]

export const FIELD_LABELS: Record<string, string> = Object.fromEntries(
    FIELDS.map(f => [f.key, f.label]),
)

/** Human label for anything the preview can report a source for,
 *  including the operator-named extras (`extras.staff_id`). */
export function labelForResolvedKey(key: string): string {
    if (key.startsWith('extras.')) return key.slice('extras.'.length)
    return FIELD_LABELS[key] ?? key
}
