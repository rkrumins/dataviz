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
}

export interface FeatureCategory {
  id: string
  label: string
  icon: string
  color: string
  sortOrder?: number
}

export interface FeaturesResponse {
  schema?: FeatureDefinition[]
  categories?: FeatureCategory[]
  values: Record<string, unknown>
  updatedAt?: string
}

// Fallback data: generated from backend seed. Regenerate with: npm run generate:features-fallback
import fallbackData from '@/generated/featuresFallback.json'

const EMBEDDED_SCHEMA: FeatureDefinition[] = fallbackData.schema as unknown as FeatureDefinition[]
const EMBEDDED_CATEGORIES: FeatureCategory[] = fallbackData.categories as unknown as FeatureCategory[]
const EMBEDDED_DEFAULTS: Record<string, unknown> = fallbackData.defaults as Record<string, unknown>

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
    throw new Error(message)
  }
  if (res.status === 204) return undefined as T
  return res.json()
}

// ─── Service ───────────────────────────────────────────────────────────────

export const featuresService = {
  /** Get feature definitions (schema). Always returns embedded schema for now. */
  getSchema(): FeatureDefinition[] {
    return EMBEDDED_SCHEMA
  },

  /** Get current feature values. Tries API first; falls back to defaults if unavailable. */
  /** Get categories (from API or embedded fallback). */
  getCategories(): FeatureCategory[] {
    return EMBEDDED_CATEGORIES
  },

  async get(): Promise<FeaturesResponse> {
    try {
      const data = await request<FeaturesResponse>(FEATURES_API)
      return {
        schema: data.schema ?? EMBEDDED_SCHEMA,
        categories: data.categories ?? EMBEDDED_CATEGORIES,
        values: data.values ?? EMBEDDED_DEFAULTS,
        updatedAt: data.updatedAt,
      }
    } catch {
      return {
        schema: EMBEDDED_SCHEMA,
        categories: EMBEDDED_CATEGORIES,
        values: { ...EMBEDDED_DEFAULTS },
      }
    }
  },

  /** Update feature values. Throws if API unavailable. */
  async update(payload: Record<string, unknown>): Promise<FeaturesResponse> {
    return request<FeaturesResponse>(FEATURES_API, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    })
  },

  /** Reset all features to defaults. */
  async reset(): Promise<FeaturesResponse> {
    return this.update(EMBEDDED_DEFAULTS as Record<string, unknown>)
  },
}
