/**
 * Features Service — CRUD for admin feature flags.
 * API base URL is configurable via env (VITE_FEATURES_API_URL or VITE_API_BASE_URL).
 * When API is unavailable, uses generated fallback (see scripts/generate-features-fallback).
 */

function getFeaturesApiUrl(): string {
  if (import.meta.env.VITE_FEATURES_API_URL) {
    return import.meta.env.VITE_FEATURES_API_URL
  }
  const base = import.meta.env.VITE_API_BASE_URL
  if (base) {
    const b = String(base).replace(/\/$/, '')
    return `${b}/api/v1/admin/features`
  }
  return '/api/v1/admin/features'
}

const FEATURES_API = getFeaturesApiUrl()

// ─── Types ────────────────────────────────────────────────────────────────

export interface FeatureOption {
  id: string
  label: string
}

export interface FeatureDefinition {
  key: string
  name: string
  description: string
  category: string
  type: 'boolean' | 'string[]'
  default: boolean | string[]
  userOverridable?: boolean
  options?: FeatureOption[]
  helpUrl?: string
  adminHint?: string
  sortOrder?: number
  deprecated?: boolean
  /** When false, show "preview / not yet wired" badge for this feature. Managed in DB per feature. */
  implemented?: boolean
}

export interface FeatureCategory {
  id: string
  label: string
  icon: string
  color: string
  sortOrder?: number
  /** When true, show "preview" badge and footer (backend-driven). */
  preview?: boolean
  previewLabel?: string | null
  previewFooter?: string | null
}

/** Page-level early-access notice (backend-driven). When enabled is false, UI shows "Enable" to turn it back on. */
export interface ExperimentalNotice {
  enabled?: boolean
  title: string
  message: string
  updatedAt?: string
}

export interface FeaturesResponse {
  schema?: FeatureDefinition[]
  categories?: FeatureCategory[]
  values: Record<string, unknown>
  updatedAt?: string
  /** Optimistic concurrency; required for PATCH. From API or 0 when using fallback. */
  version: number
  /** When set, show the early-access banner with this title and message. */
  experimentalNotice?: ExperimentalNotice | null
}

/** Thrown when PATCH returns 409 (version mismatch). Call load() and show "Someone else saved. Reloaded." */
export class FeaturesConcurrencyError extends Error {
  readonly code = 'CONFLICT' as const
  constructor(message: string) {
    super(message)
    this.name = 'FeaturesConcurrencyError'
  }
}

/** Last-resort defaults when API and fallback file are both unavailable. App never hangs or crashes. */
const FAILSAFE_VALUES: Record<string, unknown> = {
  signupEnabled: false,
  editModeEnabled: true,
  traceEnabled: true,
  allowedViewModes: ['graph', 'hierarchy', 'reference', 'layered-lineage'],
  announcementsEnabled: true,
}

function buildFailsafeResponse(): FeaturesResponse {
  return {
    schema: [],
    categories: [],
    values: { ...FAILSAFE_VALUES },
    version: 0,
    experimentalNotice: undefined,
  }
}

// Fallback data: loaded at runtime so missing/corrupt file does not crash the app (see get()).
let EMBEDDED_SCHEMA: FeatureDefinition[] = []
let EMBEDDED_CATEGORIES: FeatureCategory[] = []
let EMBEDDED_DEFAULTS: Record<string, unknown> = { ...FAILSAFE_VALUES }

async function loadFallbackData(): Promise<{
  schema: FeatureDefinition[]
  categories: FeatureCategory[]
  defaults: Record<string, unknown>
  experimentalNotice?: ExperimentalNotice | null
}> {
  try {
    const fallbackData = await import('@/generated/featuresFallback.json').then((m) => m.default)
    if (fallbackData && typeof fallbackData === 'object') {
      const schema = (fallbackData.schema as unknown as FeatureDefinition[]) ?? []
      const categories = (fallbackData.categories as unknown as FeatureCategory[]) ?? []
      const defaults = (fallbackData.defaults as Record<string, unknown>) ?? { ...FAILSAFE_VALUES }
      EMBEDDED_SCHEMA = schema
      EMBEDDED_CATEGORIES = categories
      EMBEDDED_DEFAULTS = defaults
      return {
        schema,
        categories,
        defaults,
        experimentalNotice: (fallbackData as { experimentalNotice?: ExperimentalNotice | null }).experimentalNotice,
      }
    }
  } catch {
    /* missing or corrupt fallback file */
  }
  return {
    schema: [],
    categories: [],
    defaults: { ...FAILSAFE_VALUES },
    experimentalNotice: undefined,
  }
}

// ─── API error shape (structured from backend) ─────────────────────────────

export interface FeaturesApiErrorBody {
  detail?: string | { detail?: string; code?: string; field?: string }
  retryAfter?: number
}

function parseApiError(status: number, body: unknown): string {
  if (status === 429) {
    const o = body as FeaturesApiErrorBody
    const d = o?.detail
    if (typeof d === 'object' && d?.detail) return d.detail
    return 'Too many updates. Please wait a moment before saving again.'
  }
  if (status === 409 && body && typeof body === 'object') {
    const o = body as { detail?: string | { detail?: string } }
    const d = o.detail
    if (typeof d === 'object' && d?.detail) return d.detail
    if (typeof d === 'string') return d
    return 'Feature flags were updated by someone else. Reload and try again.'
  }
  if (status === 400 && body && typeof body === 'object') {
    const o = body as { detail?: string | { detail?: string; field?: string } }
    const d = o.detail
    if (typeof d === 'object' && d?.detail) return d.detail
    if (typeof d === 'string') return d
  }
  return 'Could not save. Please try again.'
}

// ─── HTTP helper ───────────────────────────────────────────────────────────

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (!res.ok) {
    let body: unknown
    try {
      body = await res.json()
    } catch {
      body = await res.text()
    }
    const message = parseApiError(res.status, body)
    if (res.status === 409) throw new FeaturesConcurrencyError(message)
    throw new Error(message)
  }
  if (res.status === 204) return undefined as T
  return res.json()
}

// ─── Service ───────────────────────────────────────────────────────────────

export const featuresService = {
  /** Feature definitions (schema). From API or embedded fallback when offline. */
  getSchema(): FeatureDefinition[] {
    return EMBEDDED_SCHEMA
  },

  /** Category metadata. From API or embedded fallback when offline. */
  getCategories(): FeatureCategory[] {
    return EMBEDDED_CATEGORIES
  },

  /** Never throws: API → fallback file → hard-coded FAILSAFE_VALUES. */
  async get(): Promise<FeaturesResponse> {
    try {
      try {
        const data = await request<FeaturesResponse & { version?: number }>(FEATURES_API)
        return {
          schema: data.schema ?? EMBEDDED_SCHEMA,
          categories: data.categories ?? EMBEDDED_CATEGORIES,
          values: data.values ?? { ...EMBEDDED_DEFAULTS },
          updatedAt: data.updatedAt,
          version: data.version ?? 0,
          experimentalNotice: data.experimentalNotice ?? undefined,
        }
      } catch {
        const fallback = await loadFallbackData()
        return {
          schema: fallback.schema,
          categories: fallback.categories,
          values: { ...fallback.defaults },
          version: 0,
          experimentalNotice: fallback.experimentalNotice ?? undefined,
        }
      }
    } catch {
      return buildFailsafeResponse()
    }
  },

  /** Update feature values, experimental notice, and/or per-feature implemented status. Payload must include `version` (from last GET). Throws FeaturesConcurrencyError on 409. */
  async update(payload: Record<string, unknown> & { version: number }): Promise<FeaturesResponse> {
    return request<FeaturesResponse>(FEATURES_API, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    })
  },

  /** Reset all features to defaults. Requires current version (from last GET). */
  async reset(version: number): Promise<FeaturesResponse> {
    return this.update({ ...EMBEDDED_DEFAULTS, version } as Record<string, unknown> & { version: number })
  },

  /** Create a new feature definition. Body: key, name, description, category, type, default, optional fields. Returns full GET shape. */
  async createDefinition(body: CreateDefinitionBody): Promise<FeaturesResponse> {
    return request<FeaturesResponse>(`${FEATURES_API}/definitions`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
  },

  /** Update a feature definition (partial). Returns full GET shape. */
  async updateDefinition(key: string, body: Partial<CreateDefinitionBody> & { deprecated?: boolean; implemented?: boolean }): Promise<FeaturesResponse> {
    return request<FeaturesResponse>(`${FEATURES_API}/definitions/${encodeURIComponent(key)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    })
  },

  /** Soft-delete a feature (set deprecated=true, remove from values). Returns full GET shape. */
  async deprecateDefinition(key: string): Promise<FeaturesResponse> {
    return request<FeaturesResponse>(`${FEATURES_API}/definitions/${encodeURIComponent(key)}/deprecate`, {
      method: 'POST',
    })
  },
}

/** Body for creating a feature definition (camelCase). */
export interface CreateDefinitionBody {
  key: string
  name: string
  description: string
  category: string
  type: 'boolean' | 'string[]'
  default: boolean | string[]
  userOverridable?: boolean
  options?: FeatureOption[]
  helpUrl?: string | null
  adminHint?: string | null
  sortOrder?: number
  implemented?: boolean
}
