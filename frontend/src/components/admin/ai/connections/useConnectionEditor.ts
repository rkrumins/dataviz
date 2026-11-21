/**
 * State for the connection editor, kept out of the view — the idiom of SSO's
 * `useProviderEditor`: the draft is diffed against what it opened with (so
 * the footer can count unsaved changes and closing can ask first), problems
 * resolve as you type, and secrets are never sent back as the marker.
 *
 * The pure parts — the draft of a connection, the presets, validation and
 * the request body — are exported for the tests.
 */
import { useCallback, useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
    aiAdminService, AI_ADMIN_KEYS,
    type AuthTypeFields, type Connection, type ConnectionInput,
} from '@/services/aiAdminService'
import {
    authDraftFrom, authErrors, authInput, emptyAuth, type AuthDraft,
} from '../auth/authFields'
import { objectFrom, pairsFrom, type Pair } from '../ui/pairs'

export interface ConnectionDraft {
    name: string
    baseUrl: string
    auth: AuthDraft
    models: { chat: string; fast: string; embedding: string; embeddingDimensions: string }
    options: {
        chatPath: string
        embeddingsPath: string
        stream: boolean
        streamUsage: boolean
        tools: boolean
        jsonMode: boolean
        maxRetries: string
    }
    queryParams: Pair[]
    extraHeaders: Pair[]
    enabled: boolean
}

export function emptyConnection(): ConnectionDraft {
    return {
        name: '',
        baseUrl: '',
        auth: emptyAuth('api_key'),
        models: { chat: '', fast: '', embedding: '', embeddingDimensions: '' },
        options: {
            chatPath: '', embeddingsPath: '',
            stream: true, streamUsage: true, tools: true, jsonMode: true, maxRetries: '',
        },
        queryParams: [],
        extraHeaders: [],
        enabled: true,
    }
}

export function draftFromConnection(c: Connection): ConnectionDraft {
    const o = c.options ?? {}
    const m = c.models ?? {}
    return {
        name: c.name,
        baseUrl: c.baseUrl,
        auth: authDraftFrom(c.authType, c.authConfig, c.secrets),
        models: {
            chat: m.chat ?? '', fast: m.fast ?? '', embedding: m.embedding ?? '',
            embeddingDimensions: m.embeddingDimensions != null ? String(m.embeddingDimensions) : '',
        },
        options: {
            chatPath: o.chatPath ?? '',
            embeddingsPath: o.embeddingsPath ?? '',
            stream: o.stream !== false,
            streamUsage: o.streamUsage !== false,
            tools: o.tools !== false,
            jsonMode: o.jsonMode !== false,
            maxRetries: o.maxRetries != null ? String(o.maxRetries) : '',
        },
        queryParams: pairsFrom(o.queryParams),
        extraHeaders: pairsFrom(c.extraHeaders),
        enabled: c.enabled,
    }
}

// ── Presets ─────────────────────────────────────────────────────────────

export const AZURE_API_VERSION = '2024-10-21'

/** Azure OpenAI addresses a deployment by path and wants an API version on every call. */
export function withAzurePaths(d: ConnectionDraft): ConnectionDraft {
    return {
        ...d,
        options: {
            ...d.options,
            chatPath: '/openai/deployments/{model}/chat/completions',
            embeddingsPath: '/openai/deployments/{model}/embeddings',
        },
        queryParams: [
            ...d.queryParams.filter(p => p.key !== 'api-version'),
            { key: 'api-version', value: AZURE_API_VERSION },
        ],
    }
}

export interface Preset {
    id: 'openai' | 'azure' | 'local' | 'gateway'
    label: string
    blurb: string
    build: () => ConnectionDraft
}

export const PRESETS: Preset[] = [
    {
        id: 'openai', label: 'OpenAI',
        blurb: 'The OpenAI API with an API key.',
        build: () => ({
            ...emptyConnection(),
            name: 'OpenAI',
            baseUrl: 'https://api.openai.com/v1',
            models: { chat: 'gpt-4o', fast: 'gpt-4o-mini', embedding: 'text-embedding-3-small', embeddingDimensions: '' },
        }),
    },
    {
        id: 'azure', label: 'Azure OpenAI',
        blurb: 'Your resource’s deployments, the api-key header and an API version.',
        build: () => withAzurePaths({
            ...emptyConnection(),
            name: 'Azure OpenAI',
            auth: { ...emptyAuth('api_key'), config: { in: 'header', header: 'api-key', prefix: '' } },
        }),
    },
    {
        id: 'local', label: 'vLLM or Ollama',
        blurb: 'An OpenAI-compatible server on your own network, without sign-in.',
        build: () => ({
            ...emptyConnection(),
            name: 'Local model server',
            baseUrl: 'http://localhost:8000/v1',
            auth: emptyAuth('none'),
        }),
    },
    {
        id: 'gateway', label: 'Corporate gateway (token mint)',
        blurb: 'A gateway that wants a token from your sign-in endpoint first.',
        build: () => ({
            ...emptyConnection(),
            name: 'Corporate gateway',
            auth: emptyAuth('token_mint'),
        }),
    },
]

/** A preset over a draft: the preset's values, keeping a name already typed. */
export function applyPreset(draft: ConnectionDraft, preset: Preset): ConnectionDraft {
    const next = preset.build()
    return { ...next, name: draft.name.trim() || next.name, enabled: draft.enabled }
}

// ── Validation and the request ──────────────────────────────────────────

export type ConnectionErrors = Partial<Record<
    'name' | 'baseUrl' | 'chat' | 'embeddingDimensions' | 'maxRetries' | 'extraHeaders', string
>> & { auth?: Record<string, string> }

const HTTP_URL = /^https?:\/\/[^/\s?#]+/i
const RESERVED_HEADERS = new Set(['authorization', 'host', 'content-length', 'cookie'])

export function connectionErrors(d: ConnectionDraft, fields: AuthTypeFields | undefined): ConnectionErrors {
    const e: ConnectionErrors = {}
    if (!d.name.trim()) e.name = 'A connection needs a name.'
    if (!d.baseUrl.trim()) e.baseUrl = 'Where should questions be sent?'
    else if (!HTTP_URL.test(d.baseUrl.trim())) e.baseUrl = 'Enter an http(s) URL, e.g. https://api.openai.com/v1.'
    if (!d.models.chat.trim()) e.chat = 'Name the model that answers questions.'
    const dims = d.models.embeddingDimensions.trim()
    if (dims && !(Number.isInteger(Number(dims)) && Number(dims) >= 8 && Number(dims) <= 8192)) {
        e.embeddingDimensions = 'A whole number from 8 to 8192.'
    }
    const retries = d.options.maxRetries.trim()
    if (retries && !(Number.isInteger(Number(retries)) && Number(retries) >= 0 && Number(retries) <= 5)) {
        e.maxRetries = 'A whole number from 0 to 5.'
    }
    const reserved = d.extraHeaders.map(p => p.key.trim()).filter(k => RESERVED_HEADERS.has(k.toLowerCase()))
    if (reserved.length) e.extraHeaders = `${reserved.join(', ')} is set by the sign-in or the connection itself.`
    const auth = authErrors(d.auth, fields)
    if (Object.keys(auth).length) e.auth = auth
    return e
}

export function toConnectionInput(d: ConnectionDraft, fields: AuthTypeFields | undefined): ConnectionInput {
    const o = d.options
    const models: ConnectionInput['models'] = { chat: d.models.chat.trim() }
    if (d.models.fast.trim()) models.fast = d.models.fast.trim()
    if (d.models.embedding.trim()) models.embedding = d.models.embedding.trim()
    if (d.models.embeddingDimensions.trim()) models.embeddingDimensions = Number(d.models.embeddingDimensions)
    return {
        name: d.name.trim(),
        kind: 'openai_compatible',
        baseUrl: d.baseUrl.trim(),
        ...authInput(d.auth, fields),
        extraHeaders: objectFrom(d.extraHeaders),
        options: {
            ...(o.chatPath.trim() ? { chatPath: o.chatPath.trim() } : {}),
            ...(o.embeddingsPath.trim() ? { embeddingsPath: o.embeddingsPath.trim() } : {}),
            queryParams: objectFrom(d.queryParams),
            stream: o.stream,
            streamUsage: o.streamUsage,
            tools: o.tools,
            jsonMode: o.jsonMode,
            ...(o.maxRetries.trim() ? { maxRetries: Number(o.maxRetries) } : {}),
        },
        models,
        enabled: d.enabled,
    }
}

function changedKeys(a: ConnectionDraft, b: ConnectionDraft): string[] {
    return (Object.keys(a) as (keyof ConnectionDraft)[])
        .filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
}

// ── The hook ────────────────────────────────────────────────────────────

export function useConnectionEditor(connection: Connection | null, fields: AuthTypeFields | undefined) {
    const original = useMemo(() => (connection ? draftFromConnection(connection) : emptyConnection()), [connection])
    const [draft, setDraft] = useState<ConnectionDraft>(original)
    const qc = useQueryClient()

    const set = useCallback(<K extends keyof ConnectionDraft>(k: K, v: ConnectionDraft[K]) => {
        setDraft(d => ({ ...d, [k]: v }))
    }, [])

    const changed = useMemo(() => changedKeys(original, draft), [original, draft])
    const errors = useMemo(() => connectionErrors(draft, fields), [draft, fields])
    const valid = Object.keys(errors).length === 0 && Boolean(fields)

    const mutation = useMutation({
        mutationFn: (body: ConnectionInput) => (connection
            ? aiAdminService.updateConnection(connection.id, body)
            : aiAdminService.createConnection(body)),
        onSuccess: () => { void qc.invalidateQueries({ queryKey: AI_ADMIN_KEYS.connections }) },
    })

    const save = useCallback(async (): Promise<Connection | null> => {
        if (!valid) return null
        try {
            return await mutation.mutateAsync(toConnectionInput(draft, fields))
        } catch {
            return null
        }
    }, [valid, mutation, draft, fields])

    return {
        draft, set, setDraft,
        creating: !connection,
        dirty: changed.length > 0,
        changedCount: changed.length,
        errors, valid,
        saving: mutation.isPending,
        saveError: mutation.error ? (mutation.error as Error).message : null,
        save,
    }
}

export type ConnectionEditor = ReturnType<typeof useConnectionEditor>
