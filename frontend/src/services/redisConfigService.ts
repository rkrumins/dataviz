/**
 * redisConfigService — typed client for the resolved, role-keyed Redis
 * connection configuration surfaced to admins (``GET /api/v1/admin/redis/config``)
 * and the per-role connectivity probe (``POST /api/v1/admin/redis/{role}/test``).
 *
 * The config endpoint never returns a password value — only where each
 * field (including the password) was resolved *from* (env var, file,
 * per-provider override, …) so an operator can trace a bad connection back
 * to its source without anyone seeing a secret.
 */
import { authFetch } from './apiClient'

export type RedisRole = 'streams' | 'cache'

export interface RedisTlsConfig {
    enabled: boolean
    mutual: boolean
    caCertPath?: string | null
    certPath?: string | null
    keyPath?: string | null
    verifyMode?: string | null
    checkHostname?: boolean
    /** null when TLS is off — "readable" doesn't apply. */
    filesReadable: boolean | null
}

export interface RedisProviderOverride {
    providerId: string
    name: string
    host?: string | null
}

export interface RedisLegacyProvider {
    providerId: string
    name: string
}

export interface RedisRoleConfig {
    role: RedisRole
    error: string | null
    mode?: string | null
    configured?: boolean
    host?: string | null
    port?: number | null
    db?: number | null
    sentinelMaster?: string | null
    sentinelNodes?: string[]
    username?: string | null
    hasPassword?: boolean
    passwordSource?: string | null
    tls?: RedisTlsConfig
    /** field name -> where it was resolved from (e.g. host -> "REDIS_CACHE_HOST"). */
    source?: Record<string, string>
    /** cache role only. */
    providerOverrides?: RedisProviderOverride[]
    /** cache role only — providers still pointed at the deprecated CACHE_REDIS_URL. */
    legacyProviders?: RedisLegacyProvider[]
}

export interface RedisDeprecations {
    REDIS_URL: boolean
    CACHE_REDIS_URL: boolean
    providersOnLegacyCacheUrl: number
}

export interface RedisConfigResponse {
    roles: RedisRoleConfig[]
    deprecations: RedisDeprecations
}

export interface RedisTestResult {
    ok: boolean
    error: string | null
    latencyMs: number | null
}

export function fetchRedisConfig(): Promise<RedisConfigResponse> {
    return authFetch<RedisConfigResponse>('/api/v1/admin/redis/config')
}

export function testRedisRole(role: RedisRole): Promise<RedisTestResult> {
    return authFetch<RedisTestResult>(`/api/v1/admin/redis/${role}/test`, { method: 'POST' })
}
