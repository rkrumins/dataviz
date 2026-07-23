/**
 * Features Service — CRUD for admin feature flags.
 * API base URL is configurable via env (VITE_FEATURES_API_URL or VITE_API_BASE_URL).
 * When API is unavailable, uses generated fallback (see scripts/generate-features-fallback).
 */
import { fetchWithTimeout } from './fetchWithTimeout'
import { extractErrorMessage } from '@/lib/errorMessage'

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

/** Public (unauthenticated) values endpoint — the admin URL minus `/admin`. */
function getPublicValuesUrl(): string {
  return FEATURES_API.replace('/admin/features', '/features') + '/values'
}

/** Read-only flag values for app bootstrap (no auth). Null on any failure —
 *  callers keep their seeded defaults (fail-open). */
export async function fetchPublicFeatureValues(): Promise<Record<string, unknown> | null> {
  try {
    const resp = await fetchWithTimeout(getPublicValuesUrl(), {
      method: 'GET',
      timeoutMs: 8000,
      skipAuthRefresh: true,
    })
    if (!resp.ok) return null
    const body = (await resp.json()) as { values?: Record<string, unknown> }
    return body && typeof body.values === 'object' && body.values ? body.values : null
  } catch {
    return null
  }
}

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
  options?: FeatureOption[]
  helpUrl?: string
  adminHint?: string
  sortOrder?: number
  deprecated?: boolean

  // ── The prose the DB owns ────────────────────────────────────────────────
  /**
   * "What happens if I turn this off?" — the one question that decides whether an admin flips a
   * switch that affects everybody, and the one this page never answered.
   */
  impactWhenOff?: string

  // ── The facts the CODE owns (backend/app/config/feature_wiring.py) ───────
  //
  // These are served, not stored. `implemented` used to be a column an admin could tick — a claim
  // about the source tree owned by someone who cannot change the source tree — and it was wrong
  // about four flags on the day it was written. It is now derived from the gates that actually
  // exist, and a CI guard fails the build if any of it drifts from the code.

  /**
   * Where this flag is in its life.
   *
   *   experimental — the feature is still being BUILT. Ships off; turning it on is opting into
   *                  something unfinished. The page has to say so, or an admin flips it expecting
   *                  a feature and gets a building site.
   *   active       — shipped, wired end-to-end, enforced by the server. Ships ON.
   *   deprecated   — on its way out. Still honoured, but don't build anything new on it.
   */
  stage?: 'experimental' | 'active' | 'deprecated'
  /** Does this flag change anything at all? A false here means the toggle is decoration. */
  implemented?: boolean
  /** Does the SERVER refuse when this is off? A flag that only hides a button is not enforcement. */
  enforcedServerSide?: boolean
  /** How it behaves when it can't be read: capability → fail open, security → fail closed. */
  posture?: 'capability' | 'security'
  /** Concretely, which endpoints refuse. */
  serverGates?: string[]
  /** Concretely, which parts of the UI disappear. */
  uiSurfaces?: string[]
  /** What keeps working when it's off — turning a feature off is never destructive. */
  stillAllowed?: string[]
  /** Flags that must be on for this one to mean anything. */
  dependsOn?: string[]
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

/** Who changed a flag, when, and what it moved from. */
export interface FeatureChange {
  id?: string
  key?: string
  from: unknown
  to: unknown
  actorId?: string | null
  actorName: string
  at: string
}

/** One counted consequence of turning a flag off — measured against THIS estate. */
export interface ImpactFact {
  count: number
  /** Plural noun for what is counted: "views", "semantic layers". */
  label: string
  /** What becomes of them. */
  consequence: string
  /** `warning` = they lose something. `neutral` = affected, but nothing is lost. */
  tone: 'warning' | 'neutral'
  detail: string[]
}

/**
 * `known: false` means WE DID NOT MEASURE — the probe failed, or this flag has no honest count
 * behind it. It does NOT mean "nothing would be affected", and the UI must never render it as
 * reassurance: "we didn't look" and "we looked and found nothing" are different answers, and only
 * one of them is comforting.
 */
export interface FeatureImpact {
  known: boolean
  facts: ImpactFact[]
}

export interface FeaturesResponse {
  schema?: FeatureDefinition[]
  categories?: FeatureCategory[]
  values: Record<string, unknown>
  updatedAt?: string
  /** The most recent change per flag — "turned off by X, 2 days ago", beside the switch. */
  lastChanges?: Record<string, FeatureChange>
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
  // Fallback: surface the real cause instead of a bland generic line. Reached for
  // 401/403/5xx and for any empty/non-JSON body — the cases the old res.json()+res.text()
  // double-read used to crash on with a "response body already used" TypeError.
  const detail = extractErrorMessage(body, '')
  if (detail) return detail
  if (status >= 500) return `Couldn't reach the server (HTTP ${status}). Please try again.`
  if (status === 401) return 'Session expired. Please sign in again.'
  if (status === 403) return "You don't have permission to change features."
  return `Could not save (HTTP ${status}). Please try again.`
}

// ─── HTTP helper ───────────────────────────────────────────────────────────

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetchWithTimeout(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (!res.ok) {
    // Read the body exactly ONCE. Reading it twice (res.json() then res.text()) throws the
    // browser's native "Response body is already used" TypeError, which used to mask the real
    // error on every failed toggle. Parse to an object when it's JSON; keep `undefined` for an
    // empty or non-JSON body (e.g. a text/plain 500 or proxy HTML) so it never lands in a toast.
    const text = await res.text()
    let body: unknown
    try {
      body = text ? JSON.parse(text) : undefined
    } catch {
      body = undefined
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
  /** What turning this flag off would touch, counted against this estate. Never throws — a failed
   *  probe returns `known: false`, which the dialog says out loud rather than papering over. */
  async impact(key: string): Promise<FeatureImpact> {
    try {
      return await request<FeatureImpact>(`${FEATURES_API}/${encodeURIComponent(key)}/impact`)
    } catch {
      return { known: false, facts: [] }
    }
  },

  /** Everything that has happened to one flag, newest first. */
  async history(key: string): Promise<FeatureChange[]> {
    try {
      const body = await request<{ history: FeatureChange[] }>(
        `${FEATURES_API}/${encodeURIComponent(key)}/history`,
      )
      return body.history ?? []
    } catch {
      return []
    }
  },

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
  options?: FeatureOption[]
  helpUrl?: string | null
  adminHint?: string | null
  sortOrder?: number
  implemented?: boolean
}
