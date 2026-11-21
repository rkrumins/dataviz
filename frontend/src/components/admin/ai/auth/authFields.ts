/**
 * How a sign-in method is edited: the words for each field, and the draft
 * that turns into `authType` / `authConfig` / `secrets` / `secretsClear`.
 *
 * WHICH fields exist comes from the server (`GET /admin/auth-types`), so a
 * field the server adds still renders (as plain text, named by its key) and a
 * field it drops disappears. What each field is CALLED, what it is for and an
 * example of it are ours, because the server's names are API names.
 *
 * Shared by model connections and external knowledge sources, which sign in
 * the same ways.
 */
import { REDACTED } from '@/components/admin/sso/settings/ui'
import type { AuthType, AuthTypeFields } from '@/services/aiAdminService'

export type FieldKind = 'text' | 'select' | 'toggle' | 'json' | 'number'

export interface FieldMeta {
    label: string
    hint?: string
    placeholder?: string
    kind?: FieldKind
    options?: { value: string; label: string }[]
    /** What a new draft starts with. */
    initial?: string | boolean
    /** An empty value means something ("no prefix"), so it is sent; any other
     *  empty field is left out and the server's default applies. */
    keepEmpty?: boolean
    required?: boolean
    /** Offer the `{{…}}` placeholders under the editor. */
    template?: boolean
    /** Only shown when the rest of the config makes it apply. */
    showIf?: (config: Record<string, string | boolean>) => boolean
}

/** The sign-in methods, in the order they are offered. */
export const AUTH_TYPES: { value: AuthType; label: string; blurb: string }[] = [
    { value: 'none', label: 'No sign-in',
      blurb: 'The endpoint answers without credentials — usually a model server on your own network.' },
    { value: 'api_key', label: 'API key',
      blurb: 'A fixed key in a header or the query string. OpenAI, Azure OpenAI and most hosted gateways.' },
    { value: 'bearer', label: 'Bearer token',
      blurb: 'A fixed token, sent as “Authorization: Bearer …” on every call.' },
    { value: 'basic', label: 'Username and password',
      blurb: 'HTTP Basic sign-in on every call.' },
    { value: 'oauth2_client_credentials', label: 'OAuth client credentials',
      blurb: 'A client ID and secret exchanged at your identity provider for a short-lived token, refreshed before it expires.' },
    { value: 'token_mint', label: 'Token from a sign-in endpoint',
      blurb: 'Any request that returns a token — a username and password, or a body you write — sent to a token URL. For corporate gateways.' },
]

export const PLACEHOLDERS = ['{{username}}', '{{password}}', '{{clientId}}', '{{clientSecret}}'] as const

const TOKEN_URL: FieldMeta = {
    label: 'Token URL', required: true, placeholder: 'https://login.example.com/oauth2/token',
    hint: 'Where the token is requested. It must be https in production.',
}

const CONFIG: Record<string, Record<string, FieldMeta>> = {
    api_key: {
        in: {
            label: 'Send the key in', kind: 'select', initial: 'header',
            options: [{ value: 'header', label: 'A header' }, { value: 'query', label: 'The query string' }],
        },
        header: {
            label: 'Header name', initial: 'Authorization', placeholder: 'Authorization',
            hint: 'Azure OpenAI reads its key from “api-key”.',
            showIf: c => c.in !== 'query',
        },
        prefix: {
            label: 'Prefix', initial: 'Bearer', keepEmpty: true, placeholder: 'Bearer',
            hint: 'Written before the key, with a space. Leave it empty when the header takes the key alone, as Azure’s “api-key” does.',
            showIf: c => c.in !== 'query',
        },
        param: {
            label: 'Query parameter', placeholder: 'api-key',
            hint: 'The parameter the key is sent in, e.g. ?api-key=…',
            showIf: c => c.in === 'query',
        },
    },
    basic: {
        username: { label: 'Username', required: true, placeholder: 'svc-assistant' },
    },
    oauth2_client_credentials: {
        tokenUrl: TOKEN_URL,
        clientId: { label: 'Client ID', required: true, placeholder: 'a1b2c3d4-…' },
        scope: { label: 'Scope', placeholder: 'api://llm-gateway/.default', hint: 'Space-separated, when your provider asks for one.' },
        audience: { label: 'Audience', placeholder: 'https://llm.example.com', hint: 'Only some providers ask for this.' },
        clientAuth: {
            label: 'Send the client credentials', kind: 'select', initial: 'basic',
            options: [
                { value: 'basic', label: 'As a Basic header (most providers)' },
                { value: 'body', label: 'In the request body' },
            ],
        },
    },
    token_mint: {
        tokenUrl: TOKEN_URL,
        method: {
            label: 'Method', kind: 'select', initial: 'POST',
            options: [{ value: 'POST', label: 'POST' }, { value: 'GET', label: 'GET' }, { value: 'PUT', label: 'PUT' }],
        },
        bodyFormat: {
            label: 'Body format', kind: 'select', initial: 'json',
            options: [
                { value: 'json', label: 'JSON' },
                { value: 'form', label: 'Form (url-encoded)' },
                { value: 'none', label: 'No body' },
            ],
        },
        body: {
            label: 'Request body', kind: 'json', template: true,
            initial: '{\n  "username": "{{username}}",\n  "password": "{{password}}"\n}',
            hint: 'A JSON object. The placeholders are filled in from the fields below when a token is requested; secrets never appear here.',
            showIf: c => c.bodyFormat !== 'none',
        },
        headers: {
            label: 'Request headers', kind: 'json', template: true, placeholder: '{ "X-Client": "{{clientId}}" }',
            hint: 'Extra headers for the token request, as a JSON object. Placeholders work here too.',
        },
        basicAuth: {
            label: 'Also send a Basic header', kind: 'toggle', initial: false,
            hint: 'Client ID and secret (or username and password) as “Authorization: Basic …” on the token request.',
        },
        username: { label: 'Username', placeholder: 'svc-assistant', hint: 'Fills {{username}}.' },
        clientId: { label: 'Client ID', placeholder: 'assistant', hint: 'Fills {{clientId}}.' },
        tokenPath: {
            label: 'Token in the answer', initial: 'access_token', placeholder: 'access_token',
            hint: 'A dotted path into the JSON answer: access_token, data.token, result[0].value.',
        },
        expiresPath: {
            label: 'Lifetime in the answer', initial: 'expires_in', keepEmpty: true, placeholder: 'expires_in',
            hint: 'Seconds until the token expires. Leave empty when the answer has none; the default lifetime applies.',
        },
        tokenHeader: { label: 'Send the token in', initial: 'Authorization', placeholder: 'Authorization' },
        tokenPrefix: {
            label: 'Token prefix', initial: 'Bearer', keepEmpty: true, placeholder: 'Bearer',
            hint: 'Written before the token. Leave empty when the header takes the token alone.',
        },
        defaultTtlSeconds: {
            label: 'Default lifetime (seconds)', kind: 'number', placeholder: '3000',
            hint: 'Used when the answer does not say. A token is renewed at 80% of its lifetime.',
        },
    },
}

const SECRETS: Record<string, FieldMeta> = {
    apiKey: { label: 'API key', placeholder: 'sk-…' },
    token: { label: 'Token' },
    password: { label: 'Password' },
    clientSecret: { label: 'Client secret' },
}

const SECRET_HINTS: Record<string, Record<string, string>> = {
    token_mint: {
        password: 'Fills {{password}}.',
        clientSecret: 'Fills {{clientSecret}}.',
    },
}

/** The words for a config field; an unknown one is named by its key. */
export function configMeta(type: AuthType, field: string): FieldMeta {
    return CONFIG[type]?.[field] ?? { label: field }
}

export function secretMeta(type: AuthType, field: string): FieldMeta {
    const base = SECRETS[field] ?? { label: field }
    const hint = SECRET_HINTS[type]?.[field]
    return hint ? { ...base, hint } : base
}

// ── The draft ───────────────────────────────────────────────────────────

export interface AuthDraft {
    authType: AuthType
    /** Text, select and number fields as typed; JSON fields as their text; toggles as booleans. */
    config: Record<string, string | boolean>
    /** New values as typed; a configured secret holds the `********` marker. */
    secrets: Record<string, string>
    /** Configured secrets the administrator chose to remove. */
    secretsClear: string[]
}

/** A fresh draft of a method, its fields at their starting values. */
export function emptyAuth(authType: AuthType): AuthDraft {
    const config: Record<string, string | boolean> = {}
    for (const [field, meta] of Object.entries(CONFIG[authType] ?? {})) {
        if (meta.initial !== undefined) config[field] = meta.initial
    }
    return { authType, config, secrets: {}, secretsClear: [] }
}

/** The draft of a stored method: its config as editable text, its configured secrets as the marker. */
export function authDraftFrom(
    authType: AuthType,
    authConfig: Record<string, unknown>,
    secrets: Record<string, { configured: boolean }>,
): AuthDraft {
    const config: Record<string, string | boolean> = {}
    for (const [field, value] of Object.entries(authConfig ?? {})) {
        if (typeof value === 'boolean') config[field] = value
        else if (value !== null && typeof value === 'object') config[field] = JSON.stringify(value, null, 2)
        else config[field] = value == null ? '' : String(value)
    }
    const out: Record<string, string> = {}
    for (const [name, s] of Object.entries(secrets ?? {})) if (s.configured) out[name] = REDACTED
    return { authType, config, secrets: out, secretsClear: [] }
}

/** Switching method starts its fields afresh — the server takes no field of
 *  another method, and drops every stored secret when the method changes. */
export function changeAuthType(next: AuthType): AuthDraft {
    return emptyAuth(next)
}

function parseObject(text: string): Record<string, unknown> | null {
    try {
        const v: unknown = JSON.parse(text)
        return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
    } catch {
        return null
    }
}

const HTTP_URL = /^https?:\/\/[^/\s?#]+/i

/** Problems with a draft, by field, for the method's fields the server lists. */
export function authErrors(draft: AuthDraft, fields: AuthTypeFields | undefined): Record<string, string> {
    const spec = fields?.[draft.authType]
    if (!spec) return {}
    const errors: Record<string, string> = {}
    for (const field of spec.config) {
        const meta = configMeta(draft.authType, field)
        if (meta.showIf && !meta.showIf(draft.config)) continue
        const raw = draft.config[field]
        const text = typeof raw === 'string' ? raw.trim() : ''
        if (meta.required && !text) errors[field] = `${meta.label} is needed.`
        else if (meta.kind === 'json' && text && !parseObject(text)) errors[field] = 'This is not a JSON object.'
        else if (meta.kind === 'number' && text && !(Number(text) > 0)) errors[field] = 'Enter a number of seconds above 0.'
        else if (field === 'tokenUrl' && text && !HTTP_URL.test(text)) errors[field] = 'Enter an http(s) URL.'
    }
    return errors
}

/** Drop the marker and empty boxes: a secret left as it was is not sent, so
 *  the stored value stays. */
export function cleanSecrets(secrets: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(secrets).filter(([, v]) => v !== REDACTED && v !== ''))
}

/** The `authType` / `authConfig` / `secrets` / `secretsClear` of a draft, for the fields the server lists. */
export function authInput(draft: AuthDraft, fields: AuthTypeFields | undefined): {
    authType: AuthType
    authConfig: Record<string, unknown>
    secrets?: Record<string, string>
    secretsClear?: string[]
} {
    const spec = fields?.[draft.authType] ?? { config: Object.keys(draft.config), secrets: Object.keys(draft.secrets) }
    const authConfig: Record<string, unknown> = {}
    for (const field of spec.config) {
        const meta = configMeta(draft.authType, field)
        if (meta.showIf && !meta.showIf(draft.config)) continue
        const raw = draft.config[field]
        if (raw === undefined) continue
        if (typeof raw === 'boolean') { authConfig[field] = raw; continue }
        const text = raw.trim()
        if (!text) {
            if (meta.keepEmpty) authConfig[field] = ''
            continue
        }
        if (meta.kind === 'json') authConfig[field] = parseObject(text) ?? {}
        else if (meta.kind === 'number') authConfig[field] = Number(text)
        else authConfig[field] = text
    }
    const allowed = new Set(spec.secrets)
    const secrets = Object.fromEntries(Object.entries(cleanSecrets(draft.secrets)).filter(([k]) => allowed.has(k)))
    // A secret given a new value is replaced, not removed: the server applies
    // `secretsClear` after `secrets`, so naming it in both would lose the new one.
    const clear = draft.secretsClear.filter(name => !secrets[name])
    return {
        authType: draft.authType,
        authConfig,
        ...(Object.keys(secrets).length ? { secrets } : {}),
        ...(clear.length ? { secretsClear: clear } : {}),
    }
}
