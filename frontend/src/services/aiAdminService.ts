/**
 * Administration → AI: the model connections, the assistant's settings, its
 * knowledge, the business vocabulary people taught it, and its usage.
 *
 * Every route is `/api/v1/ai/admin/*` (system:admin), proxied to the AI
 * service. Secrets are write-only: a connection says which secrets are
 * configured, never what they are; omit a secret to keep it, name it in
 * `secretsClear` to remove it, and never send the `********` marker back.
 */
import { fetchWithTimeout } from './fetchWithTimeout'
import { extractErrorMessageFromText } from '@/lib/errorMessage'
import type { Predicate } from '@/types/search'

const BASE = '/api/v1/ai/admin'

export type AuthType = 'none' | 'api_key' | 'bearer' | 'basic' | 'oauth2_client_credentials' | 'token_mint'

/** `GET /admin/auth-types`: the config and secret fields each sign-in method reads. */
export type AuthTypeFields = Record<string, { config: string[]; secrets: string[] }>

export interface ConnectionOptions {
    chatPath?: string
    embeddingsPath?: string
    queryParams?: Record<string, string>
    stream?: boolean
    streamUsage?: boolean
    tools?: boolean
    jsonMode?: boolean
    maxRetries?: number
}

export interface ConnectionModels {
    chat?: string
    fast?: string
    embedding?: string
    embeddingDimensions?: number
}

export interface Capabilities {
    tools?: boolean
    nativeTools?: boolean
    streaming?: boolean
    embeddings?: boolean
    embeddingDimensions?: number | null
}

export interface Connection {
    id: string
    name: string
    kind: string
    baseUrl: string
    authType: AuthType
    authConfig: Record<string, unknown>
    /** Which secrets are set — never their values. */
    secrets: Record<string, { configured: boolean }>
    extraHeaders: Record<string, string>
    options: ConnectionOptions
    models: ConnectionModels
    capabilities: Capabilities
    enabled: boolean
    lastTest: { at: string; status: string; detail: string | null } | null
    createdAt: string
    updatedAt: string
}

export interface ConnectionInput {
    name?: string
    kind?: string
    baseUrl?: string
    authType?: AuthType
    authConfig?: Record<string, unknown>
    /** New values only. */
    secrets?: Record<string, string>
    secretsClear?: string[]
    extraHeaders?: Record<string, string>
    options?: ConnectionOptions
    models?: ConnectionModels
    enabled?: boolean
}

export interface TestCheck {
    name: 'answer' | 'tools' | 'embeddings' | string
    ok: boolean
    latencyMs?: number
    /** A sentence on failure; on success, what came back (`{model, reply}`, `{dimensions}`…). */
    detail?: unknown
    code?: string
}

export interface TestReport {
    ok: boolean
    checks: TestCheck[]
    capabilities?: Capabilities
}

export interface AiSettings {
    chatConnectionId: string | null
    fastConnectionId: string | null
    embeddingConnectionId: string | null
    personas: { data: boolean; help: boolean }
    dataPolicy: {
        sendDescriptions: boolean
        sendPropertyValues: boolean
        sendSampleValues: boolean
        maxResultRows: number
        redactPatterns: string[]
    }
    limits: {
        maxStepsPerTurn: number
        dailyTokensPerUser: number
        maxConcurrentTurnsPerUser: number
    }
    retentionDays: number
    updatedBy: string | null
    updatedAt: string | null
}

export type AiSettingsPatch = Partial<Omit<AiSettings, 'updatedBy' | 'updatedAt'>>

export interface KnowledgeCollection {
    name: 'docs' | 'views' | string
    status: 'ready' | 'building' | 'lexical' | 'disabled' | 'failed' | string
    version: string | number | null
    model: string | null
    dimensions: number | null
    documents: number | null
    chunks: number | null
    lastSyncAt: string | null
    lag: number | string | null
    error: string | null
}

export interface KnowledgeStatus {
    store: 'pgvector' | 'none' | string
    collections: KnowledgeCollection[]
}

export interface KnowledgeSource {
    id: string
    name: string
    url: string
    authType: AuthType
    authConfig: Record<string, unknown>
    secrets: Record<string, { configured: boolean }>
    toolName: string
    argumentMap: Record<string, string>
    resultMap: { items?: string; title?: string; text?: string; url?: string }
    personas: string[]
    timeoutMs: number
    trustLabel: string | null
    enabled: boolean
}

export type KnowledgeSourceInput = Partial<Omit<KnowledgeSource, 'id' | 'secrets'>> & {
    secrets?: Record<string, string>
    secretsClear?: string[]
}

/** What testing a knowledge source answers. The contract leaves the shape open;
 *  `ok` is always there, the rest is shown when present. */
export interface KnowledgeSourceTestReport {
    ok: boolean
    latencyMs?: number
    detail?: unknown
    code?: string
    sample?: { title: string; url?: string }[]
    checks?: TestCheck[]
}

export interface ConceptMapping {
    id: string
    concept: string
    label: string
    scope: 'personal' | 'workspace'
    predicate: Predicate | null
    uses: number
    updatedAt: string
}

export interface UsageReport {
    days: { day: string; requests: number; inputTokens: number; outputTokens: number }[]
    feedback: { up: number; down: number }
    recentDown: { messageId: string; question: string; comment: string | null; createdAt: string }[]
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetchWithTimeout(`${BASE}${path}`, {
        ...init,
        headers: { 'Content-Type': 'application/json', ...init?.headers },
    })
    if (!res.ok) {
        throw new Error(extractErrorMessageFromText(await res.text(), `HTTP ${res.status}`))
    }
    if (res.status === 202 || res.status === 204) return undefined as T
    return res.json()
}

const send = (method: string, body?: unknown): RequestInit => ({
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
})

export const aiAdminService = {
    authTypes: () => request<AuthTypeFields>('/auth-types'),

    listConnections: () => request<{ items: Connection[] }>('/connections').then(r => r.items),
    createConnection: (body: ConnectionInput) => request<Connection>('/connections', send('POST', body)),
    updateConnection: (id: string, body: ConnectionInput) =>
        request<Connection>(`/connections/${encodeURIComponent(id)}`, send('PATCH', body)),
    deleteConnection: (id: string) => request<void>(`/connections/${encodeURIComponent(id)}`, send('DELETE')),
    testConnection: (id: string) =>
        request<TestReport>(`/connections/${encodeURIComponent(id)}/test`, send('POST')),

    getSettings: () => request<AiSettings>('/settings'),
    saveSettings: (patch: AiSettingsPatch) => request<AiSettings>('/settings', send('PATCH', patch)),

    knowledge: () => request<KnowledgeStatus>('/knowledge'),
    reindex: (name: string) => request<void>(`/knowledge/${encodeURIComponent(name)}/reindex`, send('POST')),

    listKnowledgeSources: () =>
        request<{ items: KnowledgeSource[] }>('/knowledge-sources').then(r => r.items),
    createKnowledgeSource: (body: KnowledgeSourceInput) =>
        request<KnowledgeSource>('/knowledge-sources', send('POST', body)),
    updateKnowledgeSource: (id: string, body: KnowledgeSourceInput) =>
        request<KnowledgeSource>(`/knowledge-sources/${encodeURIComponent(id)}`, send('PATCH', body)),
    deleteKnowledgeSource: (id: string) =>
        request<void>(`/knowledge-sources/${encodeURIComponent(id)}`, send('DELETE')),
    testKnowledgeSource: (id: string) =>
        request<KnowledgeSourceTestReport>(`/knowledge-sources/${encodeURIComponent(id)}/test`, send('POST')),

    listConcepts: (dataSourceId: string) =>
        request<{ items: ConceptMapping[] }>(`/concepts?dataSourceId=${encodeURIComponent(dataSourceId)}`)
            .then(r => r.items),
    deleteConcept: (id: string) => request<void>(`/concepts/${encodeURIComponent(id)}`, send('DELETE')),
    promoteConcept: (id: string) => request<unknown>(`/concepts/${encodeURIComponent(id)}/promote`, send('POST')),

    usage: (days = 30) => request<UsageReport>(`/usage?days=${days}`),
}

/** React Query keys, under one root so Refresh can invalidate the whole page. */
export const AI_ADMIN_KEYS = {
    all: ['ai-admin'] as const,
    authTypes: ['ai-admin', 'auth-types'] as const,
    connections: ['ai-admin', 'connections'] as const,
    settings: ['ai-admin', 'settings'] as const,
    knowledge: ['ai-admin', 'knowledge'] as const,
    sources: ['ai-admin', 'knowledge-sources'] as const,
    concepts: (dataSourceId: string) => ['ai-admin', 'concepts', dataSourceId] as const,
    usage: ['ai-admin', 'usage'] as const,
}
