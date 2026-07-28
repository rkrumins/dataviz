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
        key: 'first_name', label: 'First name',
        hint: 'Falls back to splitting the display name when both name fields are empty.',
    },
    {
        key: 'last_name', label: 'Last name',
        hint: 'Falls back to splitting the display name when both name fields are empty.',
    },
    {
        key: 'display_name', label: 'Full / display name',
        hint: 'Used only when first and last name are both empty — split on the first space.',
    },
    {
        key: 'groups', label: 'Groups',
        hint: 'Feeds the IdP-group → role / internal-group mappings. Accepts a list, or a comma-separated string.',
    },
    {
        key: 'auth_time', label: 'Auth time',
        hint: 'Epoch seconds. Drives the 24h SSO re-authentication ceiling.',
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
