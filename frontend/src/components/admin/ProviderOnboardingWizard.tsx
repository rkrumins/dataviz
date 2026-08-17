import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Database,
  Globe,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Scan,
  Server,
  Shield,
  Sparkles,
  X,
  Zap,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Backdrop } from '@/components/ui/Backdrop'
import { useBrand } from '@/store/branding'
import {
  providerService,
  type ConnectionTestResult,
  type ProviderCreateRequest,
  type ProviderResponse,
  type ProviderType,
  type ProviderUpdateRequest,
  type SchemaDiscoveryResult,
} from '@/services/providerService'
import { fetchRedisConfig } from '@/services/redisConfigService'
import { useToast } from '@/components/ui/toast'
import { DocsLink } from '@/components/help/DocsLink'
import { useWizardKeyboard } from './AssetOnboardingWizard/hooks/useWizardKeyboard'
import { DataHubLogo, FalkorDBLogo, Neo4jLogo, SpannerLogo } from './ProviderLogos'
import { NodeIdentityField } from '@/components/dataSource/NodeIdentity'

type ProviderWizardStep = 'type' | 'connection' | 'schema' | 'review'
type WizardPhase = 'steps' | 'success'
type WizardMode = 'create' | 'edit'
type ConnectivityState = 'idle' | 'checking' | 'success' | 'failure'

interface SchemaMappingState {
  identityField: string
  displayNameField: string
  qualifiedNameField: string
  descriptionField: string
  tagsField: string
  entityTypeStrategy: 'label' | 'property'
  entityTypeField: string
}

interface SpannerFormState {
  projectId: string
  instanceId: string
  databaseId: string
  graphName: string
  serviceAccountJson: string
  useEmulator: boolean
}

type FalkorDBMode = 'standalone' | 'sentinel' | 'cluster'
// A single host:port node. Kept as [host, port] tuples to match the backend
// falkordbConnection node shape (also accepted as "host:port" / {host,port}).
type HostPort = [string, number]

// Dedicated cache Redis connection — structured topology + TLS (rides
// extra_config.cacheConnection, non-secret) plus its own ACL user/password
// (rides credentials, Fernet-encrypted, never echoed back). Cluster mode is
// not offered here: the cache uses SCAN + multi-key DEL and a non-zero DB
// index, neither of which works on a Redis Cluster (the backend 422s
// cacheConnection.mode: "cluster").
interface CacheConnectionState {
  enabled: boolean
  mode: 'standalone' | 'sentinel'
  host: string
  port: number
  db: number
  username: string
  password: string
  sentinelMasterName: string
  sentinelNodes: HostPort[]
  tlsEnabled: boolean
  tlsCaCertPath: string
  tlsCertPath: string
  tlsKeyPath: string
  tlsVerifyMode: 'required' | 'optional' | 'none'
  tlsCheckHostname: boolean
  // Set when editing a provider whose credentials still hold the legacy
  // cache_redis_url (detected via the redis-config dashboard's
  // legacyProviders list — GET /providers never returns credentials).
  // Renders the panel read-only with a "Convert to structured config" action.
  legacyUrlPresent: boolean
}

interface FalkorDBConnectionState {
  mode: FalkorDBMode
  // Whether the instance requires authentication (maps to
  // falkordbConnection.authEnabled). When false the graph connects
  // unauthenticated and any stored credential is dropped on save.
  authEnabled: boolean
  clusterStartupNodes: HostPort[]
  sentinelMasterName: string
  sentinelNodes: HostPort[]
  // Dedicated cache for this provider — structured panel (see CacheConnectionState).
  cache: CacheConnectionState
  // Advanced knobs kept as strings for the inputs; parsed on submit.
  socketTimeout: string
  graphPoolSize: string
  connectTimeout: string
  probeDeadlineS: string
  // Cross-cluster announced→reachable rewrites (falkordbConnection.addressRemap).
  addressRemap: Array<[string, string]>
  // Sentinel DAEMON TLS: 'inherit' = follow the data-plane TLS (backend
  // default when sentinel.tls is absent); 'on'/'off' write an explicit
  // sentinel.tls override.
  sentinelTlsMode: 'inherit' | 'on' | 'off'
  sentinelTlsCaCertPath: string
  // Sentinel DAEMON auth: none | reuse data-plane creds (sentinel.authEnabled)
  // | dedicated daemon credentials (ride the encrypted blob, write-only).
  sentinelAuthMode: 'none' | 'reuse' | 'dedicated'
  sentinelUsername: string
  sentinelPassword: string
  // TLS / mutual-TLS detail (the enable flag is the top-level `tlsEnabled`).
  // Cert inputs are file PATHS to PEMs mounted into the services (non-secret).
  tlsCaCertPath: string
  tlsCertPath: string
  tlsKeyPath: string
  tlsVerifyMode: 'required' | 'optional' | 'none'
  tlsCheckHostname: boolean
}

interface ProviderOnboardingFormData {
  providerType: ProviderType | ''
  name: string
  host: string
  port: number
  tlsEnabled: boolean
  username: string
  password: string
  // Read-only edit indicators (from ProviderResponse). Credential VALUES are
  // never returned, so these say only WHETHER a graph / cache credential is
  // already stored — the form shows "stored — leave blank to keep".
  authConfigured: boolean
  cacheAuthConfigured: boolean
  schemaMappingEnabled: boolean
  schemaMapping: SchemaMappingState
  // Node-identity DEFAULT for every data source on this provider. '' = unset,
  // so sources fall through to their workspace and then the platform default.
  identityProperty: string
  nameProperty: string
  // Spanner uses project/instance/database identifiers rather than host/port.
  // Field is optional because non-Spanner providers ignore it.
  spanner?: SpannerFormState
  // FalkorDB connection topology (standalone / sentinel / cluster).
  falkordbConnection?: FalkorDBConnectionState
  // The provider's extra_config exactly as loaded (edit mode only; never
  // rendered). buildExtraConfig REBUILDS the payload from the form fields,
  // and the backend replaces extra_config wholesale on update — so any key
  // the form doesn't own (falkordbConnection.addressRemap / connectTimeout /
  // probeDeadlineS, sentinel.tls, ops-set top-level keys, ...) must be
  // carried through from here or a routine Save silently deletes it.
  rawExtraConfig?: Record<string, any>
}

interface ConnectivityCheck {
  state: ConnectivityState
  fingerprint: string | null
  result: ConnectionTestResult | null
}

interface ProviderOnboardingWizardProps {
  isOpen: boolean
  mode?: WizardMode
  provider?: ProviderResponse | null
  providers: ProviderResponse[]
  onClose: () => void
  onCreated?: (provider: ProviderResponse, health: ConnectionTestResult) => Promise<void> | void
  onUpdated?: (provider: ProviderResponse) => Promise<void> | void
}

const PROVIDER_TYPES: Array<{
  type: ProviderType
  label: string
  Logo: typeof FalkorDBLogo
  color: string
  desc: string
}> = [
  {
    type: 'falkordb',
    label: 'FalkorDB',
    Logo: FalkorDBLogo,
    color: 'text-amber-500 bg-amber-500/10 border-amber-500/20',
    desc: 'High-performance graph database',
  },
  {
    type: 'neo4j',
    label: 'Neo4j',
    Logo: Neo4jLogo,
    color: 'text-blue-500 bg-blue-500/10 border-blue-500/20',
    desc: 'The original graph database',
  },
  {
    type: 'datahub',
    label: 'DataHub',
    Logo: DataHubLogo,
    color: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/20',
    desc: 'LinkedIn metadata platform',
  },
  {
    type: 'spanner',
    label: 'Google Spanner Graph',
    Logo: SpannerLogo,
    color: 'text-sky-500 bg-sky-500/10 border-sky-500/20',
    desc: 'Cloud-native distributed property graph (GQL). Requires Enterprise edition.',
  },
]

// The cloud-spanner-emulator is a developer-only tool; surfacing the
// toggle in production builds invites accidental misconfiguration that
// silently routes a real provider at localhost:9010. Hide the UI in prod
// AND scrub the value from any submitted payload as defense in depth.
const IS_PROD_BUILD = Boolean(import.meta.env.PROD)

const DEFAULT_SPANNER_STATE: SpannerFormState = {
  projectId: '',
  instanceId: '',
  databaseId: '',
  graphName: 'UniViz',
  serviceAccountJson: '',
  useEmulator: false,
}

const DEFAULT_CACHE_CONNECTION: CacheConnectionState = {
  enabled: false,
  mode: 'standalone',
  host: '',
  port: 6379,
  db: 0,
  username: '',
  password: '',
  sentinelMasterName: '',
  sentinelNodes: [],
  tlsEnabled: false,
  tlsCaCertPath: '',
  tlsCertPath: '',
  tlsKeyPath: '',
  tlsVerifyMode: 'required',
  tlsCheckHostname: true,
  legacyUrlPresent: false,
}

const DEFAULT_FALKORDB_CONNECTION: FalkorDBConnectionState = {
  mode: 'standalone',
  authEnabled: true,
  clusterStartupNodes: [],
  sentinelMasterName: '',
  sentinelNodes: [],
  cache: { ...DEFAULT_CACHE_CONNECTION },
  socketTimeout: '',
  graphPoolSize: '',
  connectTimeout: '',
  probeDeadlineS: '',
  addressRemap: [],
  sentinelTlsMode: 'inherit',
  sentinelTlsCaCertPath: '',
  sentinelAuthMode: 'none',
  sentinelUsername: '',
  sentinelPassword: '',
  tlsCaCertPath: '',
  tlsCertPath: '',
  tlsKeyPath: '',
  tlsVerifyMode: 'required',
  tlsCheckHostname: true,
}

const DEFAULT_SCHEMA_MAPPING: SchemaMappingState = {
  identityField: 'urn',
  displayNameField: 'displayName',
  qualifiedNameField: 'qualifiedName',
  descriptionField: 'description',
  tagsField: 'tags',
  entityTypeStrategy: 'label',
  entityTypeField: 'entityType',
}

function getProviderConfig(type: string) {
  return PROVIDER_TYPES.find((provider) => provider.type === type) ?? PROVIDER_TYPES[0]
}

function defaultPortForProvider(type: ProviderType | ''): number {
  if (type === 'neo4j') return 7687
  if (type === 'datahub') return 8080
  // Spanner has no port concept (managed gRPC); the form hides the
  // port field when type === 'spanner'. We still return a sentinel so
  // ``ProviderOnboardingFormData.port`` stays a number.
  if (type === 'spanner') return 0
  return 6379
}

function isSpanner(type: ProviderType | ''): boolean {
  return type === 'spanner'
}

// Normalize stored falkordbConnection nodes (arrays / {host,port} / "host:port")
// into [host, port] tuples for the form.
function hydrateNodes(raw: unknown): HostPort[] {
  if (!Array.isArray(raw)) return []
  return raw.map((n): HostPort => {
    if (Array.isArray(n)) return [String(n[0] ?? ''), Number(n[1] ?? 0)]
    if (n && typeof n === 'object') {
      const o = n as { host?: unknown; port?: unknown }
      return [String(o.host ?? ''), Number(o.port ?? 0)]
    }
    if (typeof n === 'string') {
      const idx = n.lastIndexOf(':')
      return idx > 0 ? [n.slice(0, idx), Number(n.slice(idx + 1))] : [n, 0]
    }
    return ['', 0]
  })
}

// Drop empty rows and coerce the port to a number on submit.
function cleanNodes(nodes: HostPort[]): HostPort[] {
  return nodes
    .filter((n) => n[0] && n[0].trim())
    .map((n): HostPort => [n[0].trim(), Number(n[1]) || 0])
}

// Parse a pasted legacy `redis://[user]:[password]@host:port/db` URL into
// structured cache fields for the "Convert to structured config" action.
// Returns null on anything that isn't a valid redis(s):// URL.
function parseLegacyCacheUrl(raw: string): Partial<CacheConnectionState> | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') return null
  const dbSegment = url.pathname.replace(/^\//, '')
  const db = dbSegment ? Number(dbSegment) : 0
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    db: Number.isFinite(db) ? db : 0,
    username: decodeURIComponent(url.username || ''),
    password: decodeURIComponent(url.password || ''),
    tlsEnabled: url.protocol === 'rediss:',
  }
}

export function buildInitialFormData(provider?: ProviderResponse | null): ProviderOnboardingFormData {
  const schemaMapping = provider?.extraConfig?.schemaMapping
  const extra = provider?.extraConfig ?? {}
  const isSpannerProvider = provider?.providerType === 'spanner'
  const isFalkorDBProvider = provider?.providerType === 'falkordb'
  const fdbConn = (isFalkorDBProvider && extra.falkordbConnection) || {}
  // cacheConnection is a TOP-LEVEL extra_config key (sibling of
  // falkordbConnection, not nested inside it) — matches the backend
  // validator, which reads extra_config.get("cacheConnection") directly.
  const cacheConn = (isFalkorDBProvider && extra.cacheConnection) || {}

  return {
    providerType: provider?.providerType ?? '',
    name: provider?.name ?? '',
    host: provider?.host ?? '',
    port: provider?.port ?? defaultPortForProvider(provider?.providerType ?? ''),
    tlsEnabled: provider?.tlsEnabled ?? false,
    rawExtraConfig: provider?.extraConfig ?? undefined,
    username: '',
    password: '',
    authConfigured: provider?.authConfigured ?? false,
    cacheAuthConfigured: provider?.cacheAuthConfigured ?? false,
    identityProperty: provider?.identityProperty ?? '',
    nameProperty: provider?.nameProperty ?? '',
    schemaMappingEnabled: Boolean(schemaMapping),
    schemaMapping: {
      identityField: schemaMapping?.identity_field ?? DEFAULT_SCHEMA_MAPPING.identityField,
      displayNameField: schemaMapping?.display_name_field ?? DEFAULT_SCHEMA_MAPPING.displayNameField,
      qualifiedNameField: schemaMapping?.qualified_name_field ?? DEFAULT_SCHEMA_MAPPING.qualifiedNameField,
      descriptionField: schemaMapping?.description_field ?? DEFAULT_SCHEMA_MAPPING.descriptionField,
      tagsField: schemaMapping?.tags_field ?? DEFAULT_SCHEMA_MAPPING.tagsField,
      entityTypeStrategy: schemaMapping?.entity_type_strategy ?? DEFAULT_SCHEMA_MAPPING.entityTypeStrategy,
      entityTypeField: schemaMapping?.entity_type_field ?? DEFAULT_SCHEMA_MAPPING.entityTypeField,
    },
    spanner: isSpannerProvider
      ? {
          projectId: extra.projectId ?? '',
          instanceId: extra.instanceId ?? '',
          databaseId: extra.databaseId ?? '',
          graphName: extra.graphName ?? DEFAULT_SPANNER_STATE.graphName,
          // Service-account JSON is not echoed back from the API for security.
          serviceAccountJson: '',
          useEmulator: Boolean(extra.useEmulator),
        }
      : { ...DEFAULT_SPANNER_STATE },
    falkordbConnection: isFalkorDBProvider
      ? {
          mode: (fdbConn.mode as FalkorDBMode) ?? 'standalone',
          // authEnabled defaults true (creds used when present); an explicit
          // false was stored to connect unauthenticated.
          authEnabled: fdbConn.authEnabled ?? true,
          clusterStartupNodes: hydrateNodes(fdbConn.cluster?.startupNodes),
          sentinelMasterName: fdbConn.sentinel?.masterName ?? '',
          sentinelNodes: hydrateNodes(fdbConn.sentinel?.nodes),
          // Non-secret topology hydrates from extra_config.cacheConnection;
          // username/password are write-only secrets (never echoed back) —
          // blank on edit, like the main password. legacyUrlPresent is
          // detected asynchronously post-mount (see the redis-config effect).
          cache: {
            enabled: Boolean(extra.cacheConnection),
            mode: (cacheConn.mode as CacheConnectionState['mode']) ?? 'standalone',
            host: cacheConn.host ?? '',
            port: cacheConn.port ?? 6379,
            db: cacheConn.db ?? 0,
            username: '',
            password: '',
            sentinelMasterName: cacheConn.sentinel?.masterName ?? '',
            sentinelNodes: hydrateNodes(cacheConn.sentinel?.nodes),
            tlsEnabled: cacheConn.tls?.enabled ?? false,
            tlsCaCertPath: cacheConn.tls?.caCertPath ?? '',
            tlsCertPath: cacheConn.tls?.certPath ?? '',
            tlsKeyPath: cacheConn.tls?.keyPath ?? '',
            tlsVerifyMode: (cacheConn.tls?.verifyMode as CacheConnectionState['tlsVerifyMode']) ?? 'required',
            tlsCheckHostname: cacheConn.tls?.checkHostname ?? true,
            legacyUrlPresent: false,
          },
          socketTimeout: fdbConn.socketTimeout != null ? String(fdbConn.socketTimeout) : '',
          graphPoolSize: fdbConn.graphPoolSize != null ? String(fdbConn.graphPoolSize) : '',
          connectTimeout: fdbConn.connectTimeout != null ? String(fdbConn.connectTimeout) : '',
          probeDeadlineS: fdbConn.probeDeadlineS != null ? String(fdbConn.probeDeadlineS) : '',
          addressRemap: Object.entries(
            (fdbConn.addressRemap ?? {}) as Record<string, string>,
          ).map(([from, to]) => [from, String(to)] as [string, string]),
          // sentinel.tls absent → the daemons inherit the data-plane TLS.
          sentinelTlsMode: fdbConn.sentinel?.tls == null
            ? 'inherit'
            : fdbConn.sentinel.tls.enabled === false ? 'off' : 'on',
          sentinelTlsCaCertPath: fdbConn.sentinel?.tls?.caCertPath ?? '',
          // Dedicated daemon creds are write-only secrets — presence rides
          // provider.sentinelAuthConfigured; authEnabled=true = reuse.
          sentinelAuthMode: provider?.sentinelAuthConfigured
            ? 'dedicated'
            : fdbConn.sentinel?.authEnabled === true ? 'reuse' : 'none',
          sentinelUsername: '',
          sentinelPassword: '',
          tlsCaCertPath: fdbConn.tls?.caCertPath ?? '',
          tlsCertPath: fdbConn.tls?.certPath ?? '',
          tlsKeyPath: fdbConn.tls?.keyPath ?? '',
          tlsVerifyMode: (fdbConn.tls?.verifyMode as FalkorDBConnectionState['tlsVerifyMode']) ?? 'required',
          tlsCheckHostname: fdbConn.tls?.checkHostname ?? true,
        }
      : { ...DEFAULT_FALKORDB_CONNECTION },
  }
}

// extra_config keys the FORM owns: it rebuilds these from its fields, so a
// missing form value means "delete the key" (e.g. disabling the cache removes
// cacheConnection). Everything NOT listed is carried through verbatim from the
// loaded provider — the backend replaces extra_config wholesale on update, so
// dropping unknown keys here silently deletes ops-configured settings.
const FORM_OWNED_EXTRA_KEYS = new Set([
  'schemaMapping',
  'projectId', 'instanceId', 'databaseId', 'graphName', 'useEmulator',
  'falkordbConnection', 'cacheConnection',
])
// Same contract one level down, inside falkordbConnection: keys the form
// edits vs. advanced knobs that only ride the API/ops tooling
// (addressRemap, connectTimeout, probeDeadlineS, and future additions).
const FORM_OWNED_FALKORDB_CONN_KEYS = new Set([
  'mode', 'sentinel', 'cluster', 'authEnabled',
  'socketTimeout', 'graphPoolSize', 'tls',
  // Advanced (rendered since the Advanced section): form-owned means the
  // form's emission is authoritative — clearing the field DELETES the key.
  'connectTimeout', 'probeDeadlineS', 'addressRemap',
])

/** Drop remap rows with an empty side (mirrors cleanNodes). */
function cleanRemap(rows: Array<[string, string]>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [from, to] of rows) {
    if (from.trim() && to.trim()) out[from.trim()] = to.trim()
  }
  return out
}

function preserveUnknownKeys(
  raw: Record<string, any> | undefined,
  owned: Set<string>,
): Record<string, any> {
  const kept: Record<string, any> = {}
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (!owned.has(key)) kept[key] = value
  }
  return kept
}

export function buildExtraConfig(formData: ProviderOnboardingFormData) {
  // Unknown keys from the loaded provider survive the rebuild; the form-owned
  // keys written below override them.
  const out: Record<string, any> = preserveUnknownKeys(
    formData.rawExtraConfig, FORM_OWNED_EXTRA_KEYS,
  )

  if (formData.schemaMappingEnabled) {
    out.schemaMapping = {
      identity_field: formData.schemaMapping.identityField,
      display_name_field: formData.schemaMapping.displayNameField,
      qualified_name_field: formData.schemaMapping.qualifiedNameField,
      description_field: formData.schemaMapping.descriptionField,
      tags_field: formData.schemaMapping.tagsField,
      entity_type_strategy: formData.schemaMapping.entityTypeStrategy,
      entity_type_field: formData.schemaMapping.entityTypeField,
    }
  }

  if (isSpanner(formData.providerType) && formData.spanner) {
    const s = formData.spanner
    if (s.projectId) out.projectId = s.projectId
    if (s.instanceId) out.instanceId = s.instanceId
    if (s.databaseId) out.databaseId = s.databaseId
    if (s.graphName) out.graphName = s.graphName
    if (!IS_PROD_BUILD && s.useEmulator) out.useEmulator = true
  }

  if (formData.providerType === 'falkordb' && formData.falkordbConnection) {
    const fc = formData.falkordbConnection
    const rawConn = (formData.rawExtraConfig?.falkordbConnection ?? {}) as Record<string, any>
    // Advanced knobs the form doesn't render (addressRemap, connectTimeout,
    // probeDeadlineS, ...) must survive a Save.
    const preservedConn = preserveUnknownKeys(rawConn, FORM_OWNED_FALKORDB_CONN_KEYS)
    const conn: Record<string, unknown> = {}
    if (fc.mode === 'sentinel') {
      conn.mode = 'sentinel'
      // Spread the stored sentinel object first: it can carry keys this panel
      // doesn't edit (legacy creds pending migration, future additions). The
      // form now OWNS masterName, nodes, authEnabled and tls.
      const sentinel: Record<string, unknown> = {
        ...(rawConn.sentinel ?? {}),
        masterName: fc.sentinelMasterName.trim(),
        nodes: cleanNodes(fc.sentinelNodes),
      }
      // Daemon auth: authEnabled=true means "reuse the data-plane creds".
      // 'dedicated' rides the credentials blob instead; 'none' omits the key
      // (backend default: unauthenticated daemons).
      if (fc.sentinelAuthMode === 'reuse') sentinel.authEnabled = true
      else delete sentinel.authEnabled
      // Daemon TLS: 'inherit' omits sentinel.tls (backend inherits the
      // data-plane TLS); 'on'/'off' write an explicit override, preserving
      // any unrendered subkeys of a stored override.
      if (fc.sentinelTlsMode === 'inherit') {
        delete sentinel.tls
      } else {
        const rawSentinelTls = (rawConn.sentinel?.tls ?? {}) as Record<string, unknown>
        sentinel.tls = {
          ...rawSentinelTls,
          enabled: fc.sentinelTlsMode === 'on',
          ...(fc.sentinelTlsMode === 'on' && fc.sentinelTlsCaCertPath.trim()
            ? { caCertPath: fc.sentinelTlsCaCertPath.trim() }
            : {}),
        }
      }
      conn.sentinel = sentinel
    } else if (fc.mode === 'cluster') {
      conn.mode = 'cluster'
      conn.cluster = { startupNodes: cleanNodes(fc.clusterStartupNodes) }
    }
    // Auth on/off. Only emit the explicit `false` (the meaningful case that tells
    // the backend to connect unauthenticated and ignore any stored credential);
    // authEnabled=true is the backend default, so omit it.
    if (!fc.authEnabled) conn.authEnabled = false
    const st = parseFloat(fc.socketTimeout)
    if (fc.socketTimeout.trim() && !Number.isNaN(st)) conn.socketTimeout = st
    const gp = parseInt(fc.graphPoolSize, 10)
    if (fc.graphPoolSize.trim() && !Number.isNaN(gp)) conn.graphPoolSize = gp
    const ct = parseFloat(fc.connectTimeout)
    if (fc.connectTimeout.trim() && !Number.isNaN(ct)) conn.connectTimeout = ct
    const pd = parseFloat(fc.probeDeadlineS)
    if (fc.probeDeadlineS.trim() && !Number.isNaN(pd)) conn.probeDeadlineS = pd
    const remap = cleanRemap(fc.addressRemap)
    if (Object.keys(remap).length > 0) conn.addressRemap = remap
    // TLS detail (CA / client cert+key / verify mode) when TLS is enabled.
    // Cert inputs are file paths (non-secret) → they ride extra_config.
    if (formData.tlsEnabled) {
      const tls: Record<string, unknown> = {
        enabled: true,
        verifyMode: fc.tlsVerifyMode,
        checkHostname: fc.tlsCheckHostname,
      }
      if (fc.tlsCaCertPath.trim()) tls.caCertPath = fc.tlsCaCertPath.trim()
      if (fc.tlsCertPath.trim()) tls.certPath = fc.tlsCertPath.trim()
      if (fc.tlsKeyPath.trim()) tls.keyPath = fc.tlsKeyPath.trim()
      conn.tls = tls
    }
    // Emit only when non-standalone OR an advanced knob/TLS is set (or a
    // preserved unknown key exists); standalone with no knobs stays the
    // legacy single-host path (no key written).
    if (
      conn.mode || conn.authEnabled === false || conn.socketTimeout != null ||
      conn.graphPoolSize != null || conn.tls ||
      conn.connectTimeout != null || conn.probeDeadlineS != null ||
      conn.addressRemap != null ||
      Object.keys(preservedConn).length > 0
    ) {
      out.falkordbConnection = { ...preservedConn, mode: conn.mode ?? 'standalone', ...conn }
    }

    // Dedicated cache: non-secret topology + TLS paths ONLY. Emitted as a
    // TOP-LEVEL extra_config.cacheConnection key (sibling of falkordbConnection,
    // not nested inside it) — the backend validator keys off
    // extra_config.get("cacheConnection"). Username/password NEVER go here
    // (see buildCredentials) — they ride credentials, Fernet-encrypted.
    const cache = fc.cache
    if (cache.enabled && !cache.legacyUrlPresent) {
      const cacheConn: Record<string, unknown> = { mode: cache.mode }
      if (cache.host.trim()) cacheConn.host = cache.host.trim()
      if (cache.port) cacheConn.port = cache.port
      if (cache.db) cacheConn.db = cache.db
      if (cache.mode === 'sentinel') {
        cacheConn.sentinel = {
          masterName: cache.sentinelMasterName.trim(),
          nodes: cleanNodes(cache.sentinelNodes),
        }
      }
      if (cache.tlsEnabled) {
        const cacheTls: Record<string, unknown> = {
          enabled: true,
          verifyMode: cache.tlsVerifyMode,
          checkHostname: cache.tlsCheckHostname,
        }
        if (cache.tlsCaCertPath.trim()) cacheTls.caCertPath = cache.tlsCaCertPath.trim()
        if (cache.tlsCertPath.trim()) cacheTls.certPath = cache.tlsCertPath.trim()
        if (cache.tlsKeyPath.trim()) cacheTls.keyPath = cache.tlsKeyPath.trim()
        cacheConn.tls = cacheTls
      }
      out.cacheConnection = cacheConn
    }
  }

  return Object.keys(out).length > 0 ? out : undefined
}

// Build the credentials payload, shared by the test, create, and update
// paths so each carries the same secrets (incl. FalkorDB's dedicated-cache
// ACL user/password — never the legacy cache_redis_url, which new saves no
// longer emit; see the "Convert to structured config" flow for that path).
export function buildCredentials(formData: ProviderOnboardingFormData) {
  if (isSpanner(formData.providerType)) {
    return formData.spanner?.serviceAccountJson || formData.spanner?.projectId
      ? {
          project_id: formData.spanner?.projectId || undefined,
          service_account_json: formData.spanner?.serviceAccountJson || undefined,
        }
      : undefined
  }
  const cache =
    formData.providerType === 'falkordb' ? formData.falkordbConnection?.cache : undefined
  const cacheActive = Boolean(cache?.enabled && !cache.legacyUrlPresent)
  const cacheUsername = cacheActive ? cache?.username.trim() || undefined : undefined
  const cachePassword = cacheActive ? cache?.password || undefined : undefined
  // Sentinel discovery authenticates with the same ACL user as the resolved
  // master — this panel doesn't expose a separate sentinel-daemon credential.
  const cacheSentinelUsername = cacheActive && cache?.mode === 'sentinel' ? cacheUsername : undefined
  const cacheSentinelPassword = cacheActive && cache?.mode === 'sentinel' ? cachePassword : undefined
  // When FalkorDB auth is toggled OFF, the graph credentials are being removed
  // (handleSubmit adds them to credentialsClear) — never send them here.
  const graphAuthOn =
    formData.providerType !== 'falkordb' || (formData.falkordbConnection?.authEnabled ?? true)
  const graphUsername = graphAuthOn ? formData.username || undefined : undefined
  const graphPassword = graphAuthOn ? formData.password || undefined : undefined
  // GRAPH sentinel-DAEMON credentials: sent only for sentinel mode with the
  // 'dedicated' auth choice ('reuse' rides sentinel.authEnabled in
  // extra_config; 'none' sends nothing). Write-only like every secret —
  // blank inputs on edit mean "keep the stored value" (merge semantics).
  const fc = formData.providerType === 'falkordb' ? formData.falkordbConnection : undefined
  const sentinelDedicated = Boolean(
    graphAuthOn && fc?.mode === 'sentinel' && fc.sentinelAuthMode === 'dedicated',
  )
  const sentinelUsername = sentinelDedicated ? fc?.sentinelUsername.trim() || undefined : undefined
  const sentinelPassword = sentinelDedicated ? fc?.sentinelPassword || undefined : undefined
  if (
    !graphUsername && !graphPassword && !cacheUsername && !cachePassword &&
    !sentinelUsername && !sentinelPassword
  ) return undefined
  return {
    username: graphUsername,
    password: graphPassword,
    cache_username: cacheUsername,
    cache_password: cachePassword,
    cache_sentinel_username: cacheSentinelUsername,
    cache_sentinel_password: cacheSentinelPassword,
    sentinel_username: sentinelUsername,
    sentinel_password: sentinelPassword,
  }
}

function buildConnectivityRequest(formData: ProviderOnboardingFormData): ProviderCreateRequest {
  // Spanner doesn't use host/port/username/password; build credentials and
  // skip host/port for that branch. Other providers stay on the legacy shape.
  const isSpannerType = isSpanner(formData.providerType)
  const credentials = buildCredentials(formData)

  return {
    name: formData.name.trim() || 'Connectivity Check',
    providerType: formData.providerType as ProviderType,
    host: isSpannerType ? undefined : (formData.host || undefined),
    port: isSpannerType ? undefined : (formData.port || undefined),
    tlsEnabled: formData.tlsEnabled,
    credentials,
    extraConfig: buildExtraConfig(formData),
    // Omitted when blank: on CREATE there is nothing to clear, so an empty
    // field means "set no provider default" rather than "clear one".
    ...(formData.identityProperty.trim()
      ? { identityProperty: formData.identityProperty.trim() } : {}),
    ...(formData.nameProperty.trim()
      ? { nameProperty: formData.nameProperty.trim() } : {}),
  }
}

function isMeaningfullyDirty(
  formData: ProviderOnboardingFormData,
  initialState: ProviderOnboardingFormData | null,
): boolean {
  if (!initialState) return false

  return JSON.stringify(formData) !== JSON.stringify(initialState)
}

function StepWarnings({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null

  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-xl border border-amber-500/20 bg-amber-500/8 px-4 py-3"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-500" />
        <div className="space-y-1 text-sm text-amber-700 dark:text-amber-300">
          {warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
      </div>
    </motion.div>
  )
}

function ConfirmCloseDialog({
  isOpen,
  onCancel,
  onConfirm,
}: {
  isOpen: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  if (!isOpen) return null

  return (
    <>
      <Backdrop open={true} zClassName="z-[120]" className="bg-black/50" />
      <div className="fixed inset-0 z-[120] flex items-center justify-center px-4 pointer-events-none">
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        className="pointer-events-auto w-full max-w-md rounded-2xl border border-glass-border bg-canvas-elevated p-6 shadow-lg"
      >
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/10 text-amber-500">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <div className="flex-1">
            <h3 className="text-lg font-semibold text-ink">Discard provider setup?</h3>
            <p className="mt-1 text-sm text-ink-muted">
              Your unsaved changes will be lost if you close the wizard now.
            </p>
          </div>
        </div>
        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-xl border border-glass-border px-4 py-2 text-sm font-medium text-ink-secondary transition-colors hover:bg-black/5 dark:hover:bg-white/5"
          >
            Keep editing
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-xl bg-red-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-600"
          >
            Discard
          </button>
        </div>
      </motion.div>
      </div>
    </>
  )
}

export function ProviderOnboardingWizard({
  isOpen,
  mode = 'create',
  provider = null,
  providers,
  onClose,
  onCreated,
  onUpdated,
}: ProviderOnboardingWizardProps) {
  const navigate = useNavigate()
  const { appName } = useBrand()
  const { showToast } = useToast()
  const modalRef = useRef<HTMLDivElement>(null)

  const [formData, setFormData] = useState<ProviderOnboardingFormData>(() => buildInitialFormData(provider))
  const [schemaDiscovery, setSchemaDiscovery] = useState<SchemaDiscoveryResult | null>(null)
  const [schemaLoading, setSchemaLoading] = useState(false)
  const [schemaError, setSchemaError] = useState<string | null>(null)
  const [currentStep, setCurrentStep] = useState<ProviderWizardStep>(mode === 'edit' ? 'connection' : 'type')
  const [previousSteps, setPreviousSteps] = useState<ProviderWizardStep[]>([])
  const [wizardPhase, setWizardPhase] = useState<WizardPhase>('steps')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [showCloseConfirm, setShowCloseConfirm] = useState(false)
  const [createdProvider, setCreatedProvider] = useState<ProviderResponse | null>(null)
  const [connectionResult, setConnectionResult] = useState<ConnectionTestResult | null>(null)
  // Scratch input for the legacy-cache "Convert to structured config" action
  // (holds the pasted redis:// URL only until it's parsed — not persisted).
  const [legacyCacheUrlInput, setLegacyCacheUrlInput] = useState('')
  const [showFalkorAdvanced, setShowFalkorAdvanced] = useState(false)
  const [connectivityCheck, setConnectivityCheck] = useState<ConnectivityCheck>({
    state: 'idle',
    fingerprint: null,
    result: null,
  })

  const initialStateRef = useRef<ProviderOnboardingFormData | null>(null)

  const steps = useMemo(() => {
    const flow: Array<{ id: ProviderWizardStep; title: string; icon: typeof Server }> = []

    if (mode === 'create') {
      flow.push({ id: 'type', title: 'Provider Type', icon: Server })
    }

    flow.push({ id: 'connection', title: 'Connection', icon: Globe })

    // Schema-mapping step appears for any non-canonical-schema provider.
    // FalkorDB and DataHub use the canonical Synodic property names; Neo4j
    // and Spanner can map foreign properties via SchemaMapping.
    if (formData.providerType === 'neo4j' || formData.providerType === 'spanner') {
      flow.push({ id: 'schema', title: 'Schema Mapping', icon: Scan })
    }

    flow.push({ id: 'review', title: 'Review', icon: Shield })
    return flow
  }, [formData.providerType, mode])

  const currentStepIndex = steps.findIndex((step) => step.id === currentStep)
  const isLastStep = currentStepIndex === steps.length - 1

  const nameDuplicate = useMemo(() => {
    const normalized = formData.name.trim().toLowerCase()
    if (!normalized) return false

    return providers.some((existing) => {
      if (mode === 'edit' && existing.id === provider?.id) return false
      return existing.name.toLowerCase() === normalized
    })
  }, [formData.name, mode, provider?.id, providers])

  const canProceed = useMemo(() => {
    switch (currentStep) {
      case 'type':
        return Boolean(formData.providerType)
      case 'connection': {
        if (!formData.name.trim() || nameDuplicate) return false
        // Spanner needs project + instance + database before we can probe.
        if (isSpanner(formData.providerType)) {
          const s = formData.spanner
          if (!s) return false
          if (!s.projectId.trim() || !s.instanceId.trim() || !s.databaseId.trim()) return false
          // In emulator mode the service-account JSON is optional.
          if (!s.useEmulator && !s.serviceAccountJson.trim()) return false
        }
        // FalkorDB sentinel/cluster need a valid node list before probing.
        if (formData.providerType === 'falkordb' && formData.falkordbConnection) {
          const fc = formData.falkordbConnection
          const validNodes = (nodes: HostPort[]) =>
            nodes.length > 0 && nodes.every((n) => n[0]?.trim() && Number(n[1]) > 0)
          if (fc.mode === 'sentinel') {
            if (!fc.sentinelMasterName.trim() || !validNodes(fc.sentinelNodes)) return false
          } else if (fc.mode === 'cluster') {
            if (!validNodes(fc.clusterStartupNodes)) return false
          }
        }
        return true
      }
      case 'schema':
        return true
      case 'review':
        return true
    }
  }, [currentStep, formData.name, formData.providerType, formData.spanner, formData.falkordbConnection, nameDuplicate])

  const stepWarnings = useMemo(() => {
    if (currentStep === 'connection') {
      const warnings: string[] = []
      if (!formData.name.trim()) warnings.push('Provider name is required.')
      if (nameDuplicate) warnings.push(`A provider named "${formData.name.trim()}" already exists.`)
      return warnings
    }

    if (currentStep === 'schema' && formData.schemaMappingEnabled && !schemaDiscovery) {
      return ['Optional: use schema discovery to auto-suggest a mapping before continuing.']
    }

    return []
  }, [currentStep, formData.name, formData.schemaMappingEnabled, nameDuplicate, schemaDiscovery])

  const isDirty = useMemo(() => isMeaningfullyDirty(formData, initialStateRef.current), [formData])
  const connectivityFingerprint = useMemo(() => JSON.stringify({
    providerType: formData.providerType,
    host: formData.host,
    port: formData.port,
    tlsEnabled: formData.tlsEnabled,
    username: formData.username,
    password: formData.password,
    schemaMappingEnabled: formData.schemaMappingEnabled,
    schemaMapping: formData.schemaMapping,
  }), [formData])

  useEffect(() => {
    if (!isOpen) return

    const nextState = buildInitialFormData(provider)
    setFormData(nextState)
    initialStateRef.current = nextState
    setSchemaDiscovery(null)
    setSchemaLoading(false)
    setSchemaError(null)
    setSubmitError(null)
    setShowCloseConfirm(false)
    setIsSubmitting(false)
    setWizardPhase('steps')
    setCreatedProvider(null)
    setConnectionResult(null)
    setConnectivityCheck({
      state: 'idle',
      fingerprint: null,
      result: null,
    })
    setPreviousSteps([])
    setCurrentStep(mode === 'edit' ? 'connection' : 'type')
    setLegacyCacheUrlInput('')
  }, [isOpen, mode, provider])

  // Detect a legacy dedicated-cache Redis URL on the credentials blob. GET
  // /providers never returns credentials (Fernet-encrypted, write-only), so
  // this reads the redis-config dashboard's legacyProviders list instead —
  // the one place that surfaces "this provider id still has cache_redis_url
  // set" without exposing the secret itself.
  useEffect(() => {
    if (!isOpen || mode !== 'edit' || provider?.providerType !== 'falkordb' || !provider?.id) return
    let cancelled = false
    const providerId = provider.id

    fetchRedisConfig()
      .then((cfg) => {
        if (cancelled) return
        const cacheRole = cfg.roles.find((role) => role.role === 'cache')
        const isLegacy = cacheRole?.legacyProviders?.some((p) => p.providerId === providerId) ?? false
        if (!isLegacy) return
        setFormData((previous) => {
          const base = previous.falkordbConnection ?? DEFAULT_FALKORDB_CONNECTION
          const next = {
            ...previous,
            falkordbConnection: {
              ...base,
              cache: { ...base.cache, legacyUrlPresent: true, enabled: true },
            },
          }
          initialStateRef.current = next
          return next
        })
      })
      .catch(() => undefined)

    return () => {
      cancelled = true
    }
  }, [isOpen, mode, provider])

  useEffect(() => {
    setConnectivityCheck((previous) => {
      if (previous.state === 'idle' && previous.fingerprint === connectivityFingerprint) {
        return previous
      }
      if (previous.fingerprint === connectivityFingerprint && previous.state !== 'idle') {
        return previous
      }
      return {
        state: 'idle',
        fingerprint: connectivityFingerprint,
        result: null,
      }
    })
  }, [connectivityFingerprint])

  const updateFormData = useCallback((updates: Partial<ProviderOnboardingFormData>) => {
    setFormData((previous) => ({ ...previous, ...updates }))
  }, [])

  const updateFalkorConn = useCallback((updates: Partial<FalkorDBConnectionState>) => {
    setFormData((previous) => ({
      ...previous,
      falkordbConnection: {
        ...(previous.falkordbConnection ?? DEFAULT_FALKORDB_CONNECTION),
        ...updates,
      },
    }))
  }, [])

  const updateCache = useCallback((updates: Partial<CacheConnectionState>) => {
    setFormData((previous) => {
      const base = previous.falkordbConnection ?? DEFAULT_FALKORDB_CONNECTION
      return {
        ...previous,
        falkordbConnection: { ...base, cache: { ...base.cache, ...updates } },
      }
    })
  }, [])

  const handleConvertLegacyCacheUrl = useCallback(() => {
    const parsed = parseLegacyCacheUrl(legacyCacheUrlInput)
    if (!parsed) return
    updateCache({ ...parsed, legacyUrlPresent: false, enabled: true })
    setLegacyCacheUrlInput('')
  }, [legacyCacheUrlInput, updateCache])

  // Repeatable host:port row editor, shared by FalkorDB's own cluster/sentinel
  // node lists and the dedicated cache's sentinel node list.
  const renderHostPortRows = (
    nodes: HostPort[],
    setNodes: (next: HostPort[]) => void,
    defaultPort: number,
  ) => {
    return (
      <div className="space-y-2">
        {nodes.map((node, idx) => (
          <div key={idx} className="flex gap-2">
            <input
              value={node[0]}
              onChange={(e) =>
                setNodes(nodes.map((n, i): HostPort => (i === idx ? [e.target.value, n[1]] : n)))
              }
              placeholder="host"
              className="flex-1 rounded-lg border border-glass-border bg-black/5 px-3 py-2 text-xs text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50 dark:bg-white/5"
            />
            <input
              type="number"
              value={node[1]}
              onChange={(e) =>
                setNodes(nodes.map((n, i): HostPort => (i === idx ? [n[0], Number(e.target.value)] : n)))
              }
              placeholder="port"
              className="w-24 rounded-lg border border-glass-border bg-black/5 px-3 py-2 text-xs text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50 dark:bg-white/5"
            />
            <button
              type="button"
              onClick={() => setNodes(nodes.filter((_, i) => i !== idx))}
              className="rounded-lg px-2 text-red-500 hover:bg-red-500/10"
              aria-label="Remove node"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => setNodes([...nodes, ['', defaultPort]])}
          className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700"
        >
          <Plus className="h-3.5 w-3.5" /> Add node
        </button>
      </div>
    )
  }

  // FalkorDB's own cluster/sentinel node lists, bound via updateFalkorConn.
  const renderNodeRows = (
    nodesKey: 'clusterStartupNodes' | 'sentinelNodes',
    defaultPort: number,
  ) => {
    const nodes = formData.falkordbConnection?.[nodesKey] ?? []
    const setNodes = (next: HostPort[]) =>
      updateFalkorConn({ [nodesKey]: next } as Partial<FalkorDBConnectionState>)
    return renderHostPortRows(nodes, setNodes, defaultPort)
  }

  const goNext = useCallback(() => {
    if (!canProceed) return
    const nextIndex = currentStepIndex + 1
    if (nextIndex >= steps.length) return

    setPreviousSteps((previous) => [...previous, currentStep])
    setCurrentStep(steps[nextIndex].id)
  }, [canProceed, currentStep, currentStepIndex, steps])

  const goBack = useCallback(() => {
    if (previousSteps.length === 0) return
    const previous = previousSteps[previousSteps.length - 1]
    setPreviousSteps((stack) => stack.slice(0, -1))
    setCurrentStep(previous)
  }, [previousSteps])

  const handleClose = useCallback(() => {
    if (wizardPhase === 'success') {
      onClose()
      return
    }

    if (isDirty) {
      setShowCloseConfirm(true)
      return
    }

    onClose()
  }, [isDirty, onClose, wizardPhase])

  const confirmClose = useCallback(() => {
    setShowCloseConfirm(false)
    onClose()
  }, [onClose])

  const handleDiscoverSchema = useCallback(async () => {
    setSchemaLoading(true)
    setSchemaError(null)

    try {
      const tempReq: ProviderCreateRequest = {
        name: `_temp_discovery_${Date.now()}`,
        providerType: 'neo4j',
        host: formData.host || 'localhost',
        port: formData.port || 7687,
        tlsEnabled: formData.tlsEnabled,
        credentials: {
          username: formData.username || undefined,
          password: formData.password || undefined,
        },
      }

      const tempProvider = await providerService.create(tempReq)
      try {
        const result = await providerService.discoverSchema(tempProvider.id)
        setSchemaDiscovery(result)

        if (result.suggestedMapping) {
          const mapping = result.suggestedMapping
          setFormData((previous) => ({
            ...previous,
            schemaMapping: {
              ...previous.schemaMapping,
              identityField: mapping.identity_field || previous.schemaMapping.identityField,
              displayNameField: mapping.display_name_field || previous.schemaMapping.displayNameField,
              qualifiedNameField: mapping.qualified_name_field || previous.schemaMapping.qualifiedNameField,
              descriptionField: mapping.description_field || previous.schemaMapping.descriptionField,
              entityTypeStrategy: mapping.entity_type_strategy || previous.schemaMapping.entityTypeStrategy,
            },
          }))
        }
      } finally {
        await providerService.delete(tempProvider.id).catch(() => undefined)
      }
    } catch (error) {
      setSchemaError(error instanceof Error ? error.message : 'Failed to discover schema')
    } finally {
      setSchemaLoading(false)
    }
  }, [formData.host, formData.password, formData.port, formData.tlsEnabled, formData.username])

  const handleTestConnection = useCallback(async () => {
    const request = buildConnectivityRequest(formData)

    setSubmitError(null)
    setConnectivityCheck({
      state: 'checking',
      fingerprint: connectivityFingerprint,
      result: null,
    })

    try {
      const result = await providerService.testConnection(request, { timeoutMs: 10_000 })
      setConnectivityCheck({
        state: result.success ? 'success' : 'failure',
        fingerprint: connectivityFingerprint,
        result,
      })
    } catch (error) {
      setConnectivityCheck({
        state: 'failure',
        fingerprint: connectivityFingerprint,
        result: {
          success: false,
          error: error instanceof Error ? error.message : 'Connection test failed',
        },
      })
    }
  }, [connectivityFingerprint, formData])

  const handleSubmit = useCallback(async () => {
    if (mode === 'create' && connectivityCheck.state === 'idle') {
      setSubmitError('Run a connection test before creating the provider.')
      return
    }

    setIsSubmitting(true)
    setSubmitError(null)

    try {
      if (mode === 'edit' && provider) {
        // A "Convert to structured config" click this session flips
        // cache.legacyUrlPresent true -> false; credentialsClear is the only
        // way to actually remove the superseded secret from the stored blob
        // (an omitted/undefined credential field just leaves the old value
        // in place — see provider_repo.update_provider's merge semantics).
        const legacyCacheConverted = Boolean(
          initialStateRef.current?.falkordbConnection?.cache.legacyUrlPresent &&
          !formData.falkordbConnection?.cache.legacyUrlPresent,
        )
        // Clear stored secrets the form no longer wants. Omitting a credential
        // field only KEEPS the stored value (provider_repo.update_provider merge
        // semantics), so removing a secret requires naming its key here.
        const credentialsClear: string[] = []
        if (legacyCacheConverted) credentialsClear.push('cache_redis_url')
        // FalkorDB auth toggled OFF → drop the stored graph credentials so the
        // connection is genuinely unauthenticated (not just authEnabled=false
        // over a lingering secret).
        if (
          formData.providerType === 'falkordb' &&
          formData.falkordbConnection &&
          !formData.falkordbConnection.authEnabled
        ) {
          credentialsClear.push('username', 'password', 'sentinel_username', 'sentinel_password')
        } else if (
          formData.providerType === 'falkordb' &&
          initialStateRef.current?.falkordbConnection?.sentinelAuthMode === 'dedicated' &&
          formData.falkordbConnection?.sentinelAuthMode !== 'dedicated'
        ) {
          // Sentinel-daemon auth switched away from dedicated credentials →
          // drop the stored daemon secrets (merge semantics would keep them).
          credentialsClear.push('sentinel_username', 'sentinel_password')
        }
        const req: ProviderUpdateRequest = {
          name: formData.name.trim(),
          host: formData.host || undefined,
          port: formData.port || undefined,
          tlsEnabled: formData.tlsEnabled,
          credentials: buildCredentials(formData),
          extraConfig: buildExtraConfig(formData),
          // Always sent, including as '' — that is how an admin CLEARS the
          // provider default so its sources fall through again. Omitting it
          // would mean "untouched", making the clear impossible to express.
          identityProperty: formData.identityProperty.trim(),
          nameProperty: formData.nameProperty.trim(),
          ...(credentialsClear.length ? { credentialsClear } : {}),
        }
        const updated = await providerService.update(provider.id, req)
        await onUpdated?.(updated)
        showToast('success', `Updated ${updated.name}`)
        onClose()
        return
      }

      const req: ProviderCreateRequest = {
        ...buildConnectivityRequest(formData),
        name: formData.name.trim(),
      }

      const created = await providerService.create(req)
      const health = connectivityCheck.result && connectivityCheck.state !== 'idle'
        ? connectivityCheck.result
        : await providerService.test(created.id)
      await onCreated?.(created, health)

      setCreatedProvider(created)
      setConnectionResult(health)
      setWizardPhase('success')
      showToast(
        health.success ? 'success' : 'warning',
        health.success
          ? `${created.name} connected successfully`
          : `${created.name} was created, but its connection needs attention`,
      )
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Failed to save provider')
    } finally {
      setIsSubmitting(false)
    }
  }, [connectivityCheck.result, connectivityCheck.state, formData, mode, onClose, onCreated, onUpdated, provider, showToast])

  const requiresConnectivityTest = mode === 'create' && currentStep === 'review'
  const shouldRunConnectivityTest = requiresConnectivityTest && connectivityCheck.state === 'idle'
  const primaryAction = shouldRunConnectivityTest ? handleTestConnection : handleSubmit

  useWizardKeyboard({
    containerRef: modalRef,
    onClose: handleClose,
    onNext: goNext,
    onSubmit: primaryAction,
    canProceed,
    isLastStep,
    isSubmitting,
    isSuccess: wizardPhase === 'success',
    isOpen,
  })

  if (!isOpen) return null

  const activeStep = steps[currentStepIndex]
  const currentConfig = getProviderConfig(formData.providerType || provider?.providerType || 'falkordb')

  const renderTypeStep = () => (
    <div className="space-y-6">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex items-start gap-3"
      >
        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl border border-indigo-500/10 bg-gradient-to-br from-indigo-500/20 to-violet-500/20">
          <Server className="h-5 w-5 text-indigo-500" />
        </div>
        <div>
          <h3 className="text-lg font-semibold text-ink">Choose your provider type</h3>
          <p className="mt-0.5 text-sm text-ink-muted">
            Start by choosing the infrastructure you want {appName} to connect to.
          </p>
        </div>
      </motion.div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {PROVIDER_TYPES.map((providerOption, index) => (
          <motion.button
            key={providerOption.type}
            type="button"
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.06 }}
            onClick={() => updateFormData({
              providerType: providerOption.type,
              port: defaultPortForProvider(providerOption.type),
            })}
            className={cn(
              'rounded-2xl border p-5 text-left transition-[colors,transform,box-shadow] duration-150 hover:-translate-y-0.5 hover:shadow-md',
              formData.providerType === providerOption.type
                ? 'border-indigo-500 bg-indigo-500/8 shadow-md'
                : 'border-glass-border bg-canvas-elevated hover:border-indigo-500/30',
            )}
          >
            <div className={cn('mb-4 flex h-11 w-11 items-center justify-center rounded-xl border', providerOption.color)}>
              <providerOption.Logo className="h-6 w-6" />
            </div>
            <div className="flex items-center justify-between gap-3">
              <h4 className="text-base font-semibold text-ink">{providerOption.label}</h4>
              {formData.providerType === providerOption.type && (
                <div className="flex h-6 w-6 items-center justify-center rounded-full bg-indigo-500 text-white">
                  <Check className="h-3.5 w-3.5" />
                </div>
              )}
            </div>
            <p className="mt-2 text-sm leading-relaxed text-ink-muted">{providerOption.desc}</p>
          </motion.button>
        ))}
      </div>
    </div>
  )

  const renderConnectionStep = () => (
    <div className="space-y-6">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex items-start gap-3"
      >
        <div className={cn('flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl border', currentConfig.color)}>
          <currentConfig.Logo className="h-5 w-5" />
        </div>
        <div className="flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-lg font-semibold text-ink">
              {mode === 'edit' ? 'Update provider details' : 'Connect your provider'}
            </h3>
            <span className="rounded-full bg-black/5 px-2.5 py-1 text-xs font-semibold text-ink-muted dark:bg-white/5">
              {currentConfig.label}
            </span>
          </div>
          <p className="mt-0.5 text-sm text-ink-muted">
            Add the infrastructure details {appName} needs in order to connect and validate access.
          </p>
        </div>
      </motion.div>

      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        <div className="space-y-4 rounded-2xl border border-glass-border bg-canvas-elevated p-5">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink">Provider name</label>
            <input
              value={formData.name}
              onChange={(event) => updateFormData({ name: event.target.value })}
              placeholder="e.g. Production Lineage Graph"
              className="w-full rounded-xl border border-glass-border bg-black/5 px-4 py-2.5 text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-indigo-500/50 dark:bg-white/5"
            />
          </div>

          {isSpanner(formData.providerType) ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-ink">GCP Project ID</label>
                  <input
                    value={formData.spanner?.projectId ?? ''}
                    onChange={(event) =>
                      updateFormData({
                        spanner: { ...(formData.spanner ?? DEFAULT_SPANNER_STATE), projectId: event.target.value },
                      })
                    }
                    placeholder="my-gcp-project"
                    className="w-full rounded-xl border border-glass-border bg-black/5 px-4 py-2.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50 dark:bg-white/5"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-ink">Instance ID</label>
                  <input
                    value={formData.spanner?.instanceId ?? ''}
                    onChange={(event) =>
                      updateFormData({
                        spanner: { ...(formData.spanner ?? DEFAULT_SPANNER_STATE), instanceId: event.target.value },
                      })
                    }
                    placeholder="uniViz-instance"
                    className="w-full rounded-xl border border-glass-border bg-black/5 px-4 py-2.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50 dark:bg-white/5"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-ink">Database ID</label>
                  <input
                    value={formData.spanner?.databaseId ?? ''}
                    onChange={(event) =>
                      updateFormData({
                        spanner: { ...(formData.spanner ?? DEFAULT_SPANNER_STATE), databaseId: event.target.value },
                      })
                    }
                    placeholder="uniViz"
                    className="w-full rounded-xl border border-glass-border bg-black/5 px-4 py-2.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50 dark:bg-white/5"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-ink">Property graph name</label>
                  <input
                    value={formData.spanner?.graphName ?? ''}
                    onChange={(event) =>
                      updateFormData({
                        spanner: { ...(formData.spanner ?? DEFAULT_SPANNER_STATE), graphName: event.target.value },
                      })
                    }
                    placeholder="UniViz"
                    className="w-full rounded-xl border border-glass-border bg-black/5 px-4 py-2.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50 dark:bg-white/5"
                  />
                </div>
              </div>
              {!IS_PROD_BUILD && (
                <label className="flex items-center justify-between rounded-xl border border-glass-border bg-black/5 px-4 py-3 dark:bg-white/5">
                  <div>
                    <p className="text-sm font-medium text-ink">Use cloud-spanner-emulator (development only)</p>
                    <p className="text-xs text-ink-muted">
                      Routes the client to <code>localhost:9010</code>. The emulator does not implement GQL —
                      schema bootstrap and queries succeed, but property-graph DDL fails. Hidden in production builds.
                    </p>
                  </div>
                  <input
                    type="checkbox"
                    checked={Boolean(formData.spanner?.useEmulator)}
                    onChange={(event) =>
                      updateFormData({
                        spanner: { ...(formData.spanner ?? DEFAULT_SPANNER_STATE), useEmulator: event.target.checked },
                      })
                    }
                    className="h-4 w-4 rounded border-glass-border text-indigo-500 focus:ring-indigo-500/50"
                  />
                </label>
              )}
              <div>
                <label className="mb-1.5 block text-sm font-medium text-ink">
                  Service account JSON
                  {formData.spanner?.useEmulator ? <span className="text-ink-muted"> (optional in emulator mode)</span> : null}
                </label>
                <textarea
                  value={formData.spanner?.serviceAccountJson ?? ''}
                  onChange={(event) =>
                    updateFormData({
                      spanner: { ...(formData.spanner ?? DEFAULT_SPANNER_STATE), serviceAccountJson: event.target.value },
                    })
                  }
                  placeholder='{"type":"service_account","project_id":"...", ...}'
                  rows={6}
                  className="w-full rounded-xl border border-glass-border bg-black/5 px-4 py-2.5 font-mono text-xs text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-indigo-500/50 dark:bg-white/5"
                />
              </div>
            </>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="mb-1.5 block text-sm font-medium text-ink">Host</label>
                  <input
                    value={formData.host}
                    onChange={(event) => updateFormData({ host: event.target.value })}
                    placeholder="localhost"
                    className="w-full rounded-xl border border-glass-border bg-black/5 px-4 py-2.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50 dark:bg-white/5"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-ink">Port</label>
                  <input
                    type="number"
                    value={formData.port}
                    onChange={(event) => updateFormData({ port: Number(event.target.value) })}
                    className="w-full rounded-xl border border-glass-border bg-black/5 px-4 py-2.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50 dark:bg-white/5"
                  />
                </div>
              </div>

              {/* Authentication. FalkorDB gets an explicit "requires auth"
                  toggle (falkordbConnection.authEnabled); other providers keep
                  simple optional credentials. Stored secrets are NEVER returned
                  by the API, so on edit we signal that they exist rather than
                  showing empty fields that read as "no credentials". */}
              {formData.providerType === 'falkordb' && (
                <label className="flex items-center justify-between gap-3 rounded-xl border border-glass-border bg-black/5 px-4 py-3 dark:bg-white/5">
                  <div>
                    <p className="text-sm font-medium text-ink">Requires authentication</p>
                    <p className="text-xs text-ink-muted">
                      Turn off for an instance with no password — the connection is unauthenticated and any stored credential is removed on save.
                    </p>
                  </div>
                  <input
                    type="checkbox"
                    checked={formData.falkordbConnection?.authEnabled ?? true}
                    onChange={(event) => updateFalkorConn({ authEnabled: event.target.checked })}
                    className="h-4 w-4 rounded border-glass-border text-indigo-500 focus:ring-indigo-500/50"
                  />
                </label>
              )}

              {(formData.providerType !== 'falkordb' || (formData.falkordbConnection?.authEnabled ?? true)) ? (
                <div className="space-y-2">
                  {mode === 'edit' && formData.authConfigured && (
                    <div className="flex items-start gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/[0.06] px-3 py-2">
                      <Shield className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
                      <p className="text-[11px] leading-relaxed text-ink-secondary">
                        Credentials are <span className="font-medium text-ink">stored</span> for this provider — leave the fields blank to keep them, or type new values to replace.
                      </p>
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-ink">Username</label>
                      <input
                        value={formData.username}
                        onChange={(event) => updateFormData({ username: event.target.value })}
                        placeholder={mode === 'edit' && formData.authConfigured ? 'default user — blank keeps stored' : 'default user (optional)'}
                        className="w-full rounded-xl border border-glass-border bg-black/5 px-4 py-2.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50 dark:bg-white/5"
                      />
                    </div>
                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-ink">Password</label>
                      <input
                        type="password"
                        value={formData.password}
                        onChange={(event) => updateFormData({ password: event.target.value })}
                        placeholder={mode === 'edit' && formData.authConfigured ? 'stored — enter to replace' : 'optional'}
                        className="w-full rounded-xl border border-glass-border bg-black/5 px-4 py-2.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50 dark:bg-white/5"
                      />
                    </div>
                  </div>
                  {formData.providerType === 'falkordb' && (
                    <p className="text-[11px] leading-tight text-ink-muted">
                      Leave the username blank for a password-only instance (default user / <code>requirepass</code>) — the same credential authenticates every standalone, sentinel, or cluster node.
                    </p>
                  )}
                </div>
              ) : (
                <div className="flex items-start gap-2 rounded-lg border border-glass-border bg-black/5 px-3 py-2.5 dark:bg-white/5">
                  <Shield className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-muted" />
                  <p className="text-[11px] leading-relaxed text-ink-secondary">
                    Connecting <span className="font-medium text-ink">without authentication</span>.
                    {mode === 'edit' && formData.authConfigured ? ' The stored credentials will be removed when you save.' : ''}
                  </p>
                </div>
              )}

              {formData.providerType === 'falkordb' && (
                <div className="space-y-3 rounded-xl border border-glass-border bg-black/5 p-4 dark:bg-white/5">
                  <div className="flex items-center gap-2">
                    <Server className="h-4 w-4 text-amber-500" />
                    <p className="text-sm font-medium text-ink">Connection topology</p>
                  </div>

                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-ink">Mode</label>
                    <select
                      value={formData.falkordbConnection?.mode ?? 'standalone'}
                      onChange={(event) =>
                        updateFalkorConn({ mode: event.target.value as FalkorDBMode })
                      }
                      className="w-full rounded-lg border border-glass-border bg-black/5 px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50 dark:bg-white/5"
                    >
                      <option value="standalone">Standalone (single host)</option>
                      <option value="sentinel">Redis Sentinel (HA)</option>
                      <option value="cluster">Redis Cluster</option>
                    </select>
                    <p className="mt-1 text-[11px] leading-tight text-ink-muted">
                      Standalone uses the Host/Port above. A single FalkorDB graph lives on one
                      cluster shard — cluster mode routes to the shard that owns the graph key.
                    </p>
                  </div>

                  {formData.falkordbConnection?.mode !== 'standalone' && (
                    <div className="flex items-start gap-2 rounded-lg border border-indigo-500/20 bg-indigo-500/[0.06] px-3 py-2">
                      <Shield className="mt-0.5 h-3.5 w-3.5 shrink-0 text-indigo-500" />
                      <p className="text-[11px] leading-relaxed text-ink-secondary">
                        The <span className="font-medium text-ink">Username / Password</span> above are
                        the graph credentials for {formData.falkordbConnection?.mode === 'cluster' ? 'every cluster node' : 'the master and its replicas'}.
                        {formData.falkordbConnection?.mode === 'cluster'
                          ? ' A Redis Cluster shares one credential across all shards — there is no per-node password.'
                          : ' Sentinel data-plane auth reuses these; the sentinel daemons only need their own auth if you enable it.'}
                        {' '}Turn off “Requires authentication” above for an unauthenticated instance.
                      </p>
                    </div>
                  )}

                  {formData.falkordbConnection?.mode === 'cluster' && (
                    <div>
                      <label className="mb-1.5 block text-xs font-medium text-ink">
                        Cluster startup nodes
                      </label>
                      {renderNodeRows('clusterStartupNodes', 6379)}
                    </div>
                  )}

                  {formData.falkordbConnection?.mode === 'sentinel' && (
                    <>
                      <div>
                        <label className="mb-1.5 block text-xs font-medium text-ink">
                          Sentinel master name
                        </label>
                        <input
                          value={formData.falkordbConnection?.sentinelMasterName ?? ''}
                          onChange={(event) =>
                            updateFalkorConn({ sentinelMasterName: event.target.value })
                          }
                          placeholder="mymaster"
                          className="w-full rounded-lg border border-glass-border bg-black/5 px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50 dark:bg-white/5"
                        />
                      </div>
                      <div>
                        <label className="mb-1.5 block text-xs font-medium text-ink">
                          Sentinel nodes
                        </label>
                        {renderNodeRows('sentinelNodes', 26379)}
                      </div>
                    </>
                  )}

                  {/* Provider cache lives in its own full-width section below the two
                      columns (see "Provider cache") so this column stays focused on the
                      graph connection + topology. */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="mb-1.5 block text-xs font-medium text-ink">
                        Socket timeout (s)
                      </label>
                      <input
                        type="number"
                        value={formData.falkordbConnection?.socketTimeout ?? ''}
                        onChange={(event) =>
                          updateFalkorConn({ socketTimeout: event.target.value })
                        }
                        placeholder="10"
                        className="w-full rounded-lg border border-glass-border bg-black/5 px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50 dark:bg-white/5"
                      />
                    </div>
                    <div>
                      <label className="mb-1.5 block text-xs font-medium text-ink">
                        Graph pool size
                      </label>
                      <input
                        type="number"
                        value={formData.falkordbConnection?.graphPoolSize ?? ''}
                        onChange={(event) =>
                          updateFalkorConn({ graphPoolSize: event.target.value })
                        }
                        placeholder="24"
                        className="w-full rounded-lg border border-glass-border bg-black/5 px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50 dark:bg-white/5"
                      />
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => setShowFalkorAdvanced((v) => !v)}
                    className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700"
                  >
                    <ChevronRight
                      className={cn('h-3.5 w-3.5 transition-transform', showFalkorAdvanced && 'rotate-90')}
                    />
                    Advanced
                  </button>

                  {showFalkorAdvanced && (
                    <div className="space-y-3 border-t border-glass-border pt-3">
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="mb-1.5 block text-xs font-medium text-ink">
                            Connect timeout (s)
                          </label>
                          <input
                            type="number"
                            value={formData.falkordbConnection?.connectTimeout ?? ''}
                            onChange={(event) =>
                              updateFalkorConn({ connectTimeout: event.target.value })
                            }
                            placeholder="5"
                            className="w-full rounded-lg border border-glass-border bg-black/5 px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50 dark:bg-white/5"
                          />
                        </div>
                        <div>
                          <label className="mb-1.5 block text-xs font-medium text-ink">
                            Probe deadline (s)
                          </label>
                          <input
                            type="number"
                            value={formData.falkordbConnection?.probeDeadlineS ?? ''}
                            onChange={(event) =>
                              updateFalkorConn({ probeDeadlineS: event.target.value })
                            }
                            placeholder="8"
                            className="w-full rounded-lg border border-glass-border bg-black/5 px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50 dark:bg-white/5"
                          />
                        </div>
                      </div>
                      <p className="text-[11px] leading-tight text-ink-muted">
                        The probe deadline extends (never shrinks) the warmup budget for slow
                        cross-cluster links.
                      </p>

                      <div>
                        <label className="mb-1.5 block text-xs font-medium text-ink">
                          Address remap
                        </label>
                        <p className="mb-1.5 text-[11px] leading-tight text-ink-muted">
                          Rewrites node addresses the server announces (cluster slot map, sentinel
                          master) to addresses reachable from this cluster — for cross-cluster
                          setups where internal pod IPs aren’t routable.
                        </p>
                        <div className="space-y-2">
                          {(formData.falkordbConnection?.addressRemap ?? []).map(([from, to], idx) => (
                            <div key={idx} className="flex items-center gap-2">
                              <input
                                value={from}
                                onChange={(event) => {
                                  const rows = [...(formData.falkordbConnection?.addressRemap ?? [])]
                                  rows[idx] = [event.target.value, rows[idx][1]]
                                  updateFalkorConn({ addressRemap: rows })
                                }}
                                placeholder="10.0.0.5:6379"
                                className="flex-1 rounded-lg border border-glass-border bg-black/5 px-3 py-2 text-xs text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50 dark:bg-white/5"
                              />
                              <span className="text-xs text-ink-muted">→</span>
                              <input
                                value={to}
                                onChange={(event) => {
                                  const rows = [...(formData.falkordbConnection?.addressRemap ?? [])]
                                  rows[idx] = [rows[idx][0], event.target.value]
                                  updateFalkorConn({ addressRemap: rows })
                                }}
                                placeholder="edge.example.com:6379"
                                className="flex-1 rounded-lg border border-glass-border bg-black/5 px-3 py-2 text-xs text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50 dark:bg-white/5"
                              />
                              <button
                                type="button"
                                onClick={() =>
                                  updateFalkorConn({
                                    addressRemap: (formData.falkordbConnection?.addressRemap ?? []).filter(
                                      (_, i) => i !== idx,
                                    ),
                                  })
                                }
                                className="rounded-lg px-2 text-red-500 hover:bg-red-500/10"
                                aria-label="Remove remap"
                              >
                                <X className="h-4 w-4" />
                              </button>
                            </div>
                          ))}
                          <button
                            type="button"
                            onClick={() =>
                              updateFalkorConn({
                                addressRemap: [...(formData.falkordbConnection?.addressRemap ?? []), ['', '']],
                              })
                            }
                            className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700"
                          >
                            <Plus className="h-3.5 w-3.5" /> Add remap
                          </button>
                        </div>
                      </div>

                      {formData.falkordbConnection?.mode === 'sentinel' && (
                        <>
                          <div>
                            <label className="mb-1.5 block text-xs font-medium text-ink">
                              Sentinel daemon TLS
                            </label>
                            <select
                              value={formData.falkordbConnection?.sentinelTlsMode ?? 'inherit'}
                              onChange={(event) =>
                                updateFalkorConn({
                                  sentinelTlsMode: event.target.value as 'inherit' | 'on' | 'off',
                                })
                              }
                              className="w-full rounded-lg border border-glass-border bg-black/5 px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50 dark:bg-white/5"
                            >
                              <option value="inherit">Same as data plane (inherit)</option>
                              <option value="on">TLS on</option>
                              <option value="off">TLS off</option>
                            </select>
                            {formData.falkordbConnection?.sentinelTlsMode === 'on' && (
                              <input
                                value={formData.falkordbConnection?.sentinelTlsCaCertPath ?? ''}
                                onChange={(event) =>
                                  updateFalkorConn({ sentinelTlsCaCertPath: event.target.value })
                                }
                                placeholder="CA certificate path (optional)"
                                className="mt-2 w-full rounded-lg border border-glass-border bg-black/5 px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50 dark:bg-white/5"
                              />
                            )}
                          </div>

                          <div>
                            <label className="mb-1.5 block text-xs font-medium text-ink">
                              Sentinel daemon authentication
                            </label>
                            <select
                              value={formData.falkordbConnection?.sentinelAuthMode ?? 'none'}
                              onChange={(event) =>
                                updateFalkorConn({
                                  sentinelAuthMode: event.target.value as 'none' | 'reuse' | 'dedicated',
                                })
                              }
                              className="w-full rounded-lg border border-glass-border bg-black/5 px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50 dark:bg-white/5"
                            >
                              <option value="none">None (unauthenticated daemons)</option>
                              <option value="reuse">Reuse the graph credentials</option>
                              <option value="dedicated">Dedicated daemon credentials</option>
                            </select>
                            {formData.falkordbConnection?.sentinelAuthMode === 'dedicated' && (
                              <div className="mt-2 space-y-2">
                                {!formData.falkordbConnection?.authEnabled && (
                                  <p className="text-[11px] leading-tight text-amber-600">
                                    Requires “Requires authentication” to be enabled above —
                                    daemon credentials are cleared when graph auth is off.
                                  </p>
                                )}
                                <input
                                  value={formData.falkordbConnection?.sentinelUsername ?? ''}
                                  onChange={(event) =>
                                    updateFalkorConn({ sentinelUsername: event.target.value })
                                  }
                                  placeholder={
                                    provider?.sentinelAuthConfigured
                                      ? 'Daemon username (stored — leave blank to keep)'
                                      : 'Daemon username (optional)'
                                  }
                                  className="w-full rounded-lg border border-glass-border bg-black/5 px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50 dark:bg-white/5"
                                />
                                <input
                                  type="password"
                                  value={formData.falkordbConnection?.sentinelPassword ?? ''}
                                  onChange={(event) =>
                                    updateFalkorConn({ sentinelPassword: event.target.value })
                                  }
                                  placeholder={
                                    provider?.sentinelAuthConfigured
                                      ? 'Daemon password (stored — leave blank to keep)'
                                      : 'Daemon password'
                                  }
                                  className="w-full rounded-lg border border-glass-border bg-black/5 px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50 dark:bg-white/5"
                                />
                              </div>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        <div className="space-y-4 rounded-2xl border border-glass-border bg-black/[0.02] p-5 dark:bg-white/[0.02]">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-500/10 text-indigo-500">
              <Shield className="h-5 w-5" />
            </div>
            <div>
              <h4 className="text-sm font-semibold text-ink">Connection guidance</h4>
              <p className="text-xs text-ink-muted">These details are stored as infrastructure settings only.</p>
            </div>
          </div>

          <ul className="space-y-3 text-sm text-ink-muted">
            <li className="flex items-start gap-2">
              <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-500" />
              Use a clear provider name so it’s easy to identify later in data source onboarding.
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-500" />
              Credentials are optional unless your provider requires authentication.
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-500" />
              After saving, {appName} will test the connection before you move on to data sources.
            </li>
          </ul>

          <label className="flex items-center justify-between rounded-xl border border-glass-border bg-black/5 px-4 py-3 dark:bg-white/5">
            <div>
              <p className="text-sm font-medium text-ink">Use TLS</p>
              <p className="text-xs text-ink-muted">Enable secure transport when your provider expects it.</p>
            </div>
            <input
              type="checkbox"
              checked={formData.tlsEnabled}
              onChange={(event) => updateFormData({ tlsEnabled: event.target.checked })}
              className="h-4 w-4 rounded border-glass-border text-indigo-500 focus:ring-indigo-500/50"
            />
          </label>

          {formData.providerType === 'falkordb' && formData.tlsEnabled && (
            <div className="mt-3 space-y-3 rounded-xl border border-glass-border bg-black/5 p-4 dark:bg-white/5">
              <p className="text-xs font-medium text-ink">TLS / mutual TLS</p>
              <p className="text-[11px] leading-tight text-ink-muted">
                Paths to PEM files mounted into the services. Leave the CA blank to use the
                system trust store; set client cert + key for mutual TLS.
              </p>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-ink">
                  CA certificate path <span className="text-ink-muted">(optional)</span>
                </label>
                <input
                  value={formData.falkordbConnection?.tlsCaCertPath ?? ''}
                  onChange={(event) => updateFalkorConn({ tlsCaCertPath: event.target.value })}
                  placeholder="/certs/ca.crt"
                  className="w-full rounded-lg border border-glass-border bg-black/5 px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50 dark:bg-white/5"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-ink">
                    Client cert path <span className="text-ink-muted">(mTLS)</span>
                  </label>
                  <input
                    value={formData.falkordbConnection?.tlsCertPath ?? ''}
                    onChange={(event) => updateFalkorConn({ tlsCertPath: event.target.value })}
                    placeholder="/certs/client.crt"
                    className="w-full rounded-lg border border-glass-border bg-black/5 px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50 dark:bg-white/5"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-ink">
                    Client key path <span className="text-ink-muted">(mTLS)</span>
                  </label>
                  <input
                    value={formData.falkordbConnection?.tlsKeyPath ?? ''}
                    onChange={(event) => updateFalkorConn({ tlsKeyPath: event.target.value })}
                    placeholder="/certs/client.key"
                    className="w-full rounded-lg border border-glass-border bg-black/5 px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50 dark:bg-white/5"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-ink">Verify mode</label>
                  <select
                    value={formData.falkordbConnection?.tlsVerifyMode ?? 'required'}
                    onChange={(event) =>
                      updateFalkorConn({
                        tlsVerifyMode: event.target.value as FalkorDBConnectionState['tlsVerifyMode'],
                      })
                    }
                    className="w-full rounded-lg border border-glass-border bg-black/5 px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50 dark:bg-white/5"
                  >
                    <option value="required">Required (verify server)</option>
                    <option value="optional">Optional</option>
                    <option value="none">None (self-signed)</option>
                  </select>
                </div>
                <label className="flex items-end gap-2 pb-2 text-xs text-ink">
                  <input
                    type="checkbox"
                    checked={formData.falkordbConnection?.tlsCheckHostname ?? true}
                    onChange={(event) =>
                      updateFalkorConn({ tlsCheckHostname: event.target.checked })
                    }
                    className="h-4 w-4 rounded border-glass-border text-indigo-500 focus:ring-indigo-500/50"
                  />
                  Check hostname
                </label>
              </div>
            </div>
          )}
        </div>
      </div>

      {formData.providerType === 'falkordb' && (
                  <div className="space-y-3 rounded-xl border border-glass-border bg-black/5 p-4 dark:bg-white/5">
                    {/* What the cache is for + the best-effort promise */}
                    <div className="flex items-start gap-2.5">
                      <Zap className="mt-0.5 h-4 w-4 shrink-0 text-indigo-500" />
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-ink">Read cache</p>
                        <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">
                          This provider caches computed graph reads (ancestor chains, labels, stats) so
                          repeat reads are instant. The cache is best-effort — if it&rsquo;s ever
                          unavailable, reads are recomputed and nothing breaks.
                        </p>
                      </div>
                    </div>

                    <label className="flex items-center justify-between border-t border-glass-border/70 pt-3">
                      <div className="pr-3">
                        <p className="text-sm font-medium text-ink">Use a dedicated cache for this provider</p>
                        <p className="text-xs text-ink-muted">
                          Give this provider its own cache Redis — own host, credentials and TLS,
                          insulated from changes to the global cache. Recommended when the graph runs
                          in Redis Cluster mode.
                        </p>
                      </div>
                      <input
                        type="checkbox"
                        checked={formData.falkordbConnection?.cache.enabled ?? false}
                        disabled={formData.falkordbConnection?.cache.legacyUrlPresent ?? false}
                        onChange={(event) => updateCache({ enabled: event.target.checked })}
                        className="h-4 w-4 rounded border-glass-border text-indigo-500 focus:ring-indigo-500/50"
                      />
                    </label>

                    {/* DEFAULT — say plainly what happens when the box is left unchecked */}
                    {!(formData.falkordbConnection?.cache.enabled ?? false) && (
                      <div className="flex items-start gap-2 rounded-lg border border-indigo-500/20 bg-indigo-500/[0.06] px-3 py-2.5">
                        <Globe className="mt-0.5 h-3.5 w-3.5 shrink-0 text-indigo-500" />
                        <p className="text-[11px] leading-relaxed text-ink-secondary">
                          <span className="font-semibold text-ink">Using the shared cache.</span>{' '}
                          Left unchecked, this provider uses the platform&rsquo;s global cache Redis —
                          configured centrally under{' '}
                          <span className="font-medium text-indigo-600 dark:text-indigo-400">Admin › Redis</span>{' '}
                          and shared with every other provider. Nothing more to set up here. If no
                          global cache is configured there, the provider simply runs without a cache
                          (reads are recomputed on demand — still fully functional, just not cached).
                        </p>
                      </div>
                    )}

                    {formData.falkordbConnection?.cache.enabled && (
                      formData.falkordbConnection.cache.legacyUrlPresent ? (
                        <div className="space-y-2 rounded-lg border border-amber-500/20 bg-amber-500/8 p-3">
                          <p className="text-[11px] leading-tight text-amber-700 dark:text-amber-300">
                            This provider still uses the legacy dedicated-cache Redis URL (write-only,
                            hidden). Paste it below to convert it into structured fields.
                          </p>
                          <div className="flex gap-2">
                            <input
                              type="password"
                              value={legacyCacheUrlInput}
                              onChange={(event) => setLegacyCacheUrlInput(event.target.value)}
                              placeholder="redis://:password@cache-host:6379/0"
                              className="flex-1 rounded-lg border border-glass-border bg-black/5 px-3 py-2 text-xs text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50 dark:bg-white/5"
                            />
                            <button
                              type="button"
                              onClick={handleConvertLegacyCacheUrl}
                              disabled={!legacyCacheUrlInput.trim()}
                              className="whitespace-nowrap rounded-lg bg-indigo-500/10 px-3 py-2 text-xs font-semibold text-indigo-600 transition-colors hover:bg-indigo-500/20 disabled:opacity-50 dark:text-indigo-400"
                            >
                              Convert to structured config
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-3">
                          <div>
                            <label className="mb-1.5 block text-xs font-medium text-ink">Cache mode</label>
                            <select
                              value={formData.falkordbConnection.cache.mode}
                              onChange={(event) =>
                                updateCache({ mode: event.target.value as CacheConnectionState['mode'] })
                              }
                              className="w-full rounded-lg border border-glass-border bg-black/5 px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50 dark:bg-white/5"
                            >
                              <option value="standalone">Standalone (single host)</option>
                              <option value="sentinel">Redis Sentinel (HA)</option>
                            </select>
                          </div>

                          <div className="grid grid-cols-3 gap-3">
                            <div className="col-span-2">
                              <label className="mb-1.5 block text-xs font-medium text-ink">Cache host</label>
                              <input
                                value={formData.falkordbConnection.cache.host}
                                onChange={(event) => updateCache({ host: event.target.value })}
                                placeholder="cache-host"
                                className="w-full rounded-lg border border-glass-border bg-black/5 px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50 dark:bg-white/5"
                              />
                            </div>
                            <div>
                              <label className="mb-1.5 block text-xs font-medium text-ink">Cache port</label>
                              <input
                                type="number"
                                value={formData.falkordbConnection.cache.port}
                                onChange={(event) => updateCache({ port: Number(event.target.value) })}
                                placeholder="cache-port"
                                className="w-full rounded-lg border border-glass-border bg-black/5 px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50 dark:bg-white/5"
                              />
                            </div>
                          </div>

                          <div className="grid grid-cols-3 gap-3">
                            <div>
                              <label className="mb-1.5 block text-xs font-medium text-ink">DB index</label>
                              <input
                                type="number"
                                value={formData.falkordbConnection.cache.db}
                                onChange={(event) => updateCache({ db: Number(event.target.value) })}
                                placeholder="cache-db"
                                className="w-full rounded-lg border border-glass-border bg-black/5 px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50 dark:bg-white/5"
                              />
                            </div>
                            <div>
                              <label className="mb-1.5 block text-xs font-medium text-ink">Cache username</label>
                              <input
                                value={formData.falkordbConnection.cache.username}
                                onChange={(event) => updateCache({ username: event.target.value })}
                                placeholder="cache-user"
                                className="w-full rounded-lg border border-glass-border bg-black/5 px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50 dark:bg-white/5"
                              />
                            </div>
                            <div>
                              <label className="mb-1.5 block text-xs font-medium text-ink">Cache password</label>
                              <input
                                type="password"
                                value={formData.falkordbConnection.cache.password}
                                onChange={(event) => updateCache({ password: event.target.value })}
                                placeholder={mode === 'edit' ? 'unchanged — enter to replace' : 'cache-password'}
                                className="w-full rounded-lg border border-glass-border bg-black/5 px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50 dark:bg-white/5"
                              />
                            </div>
                          </div>

                          {formData.falkordbConnection.cache.mode === 'sentinel' && (
                            <>
                              <div>
                                <label className="mb-1.5 block text-xs font-medium text-ink">
                                  Cache sentinel master name
                                </label>
                                <input
                                  value={formData.falkordbConnection.cache.sentinelMasterName}
                                  onChange={(event) => updateCache({ sentinelMasterName: event.target.value })}
                                  placeholder="mymaster"
                                  className="w-full rounded-lg border border-glass-border bg-black/5 px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50 dark:bg-white/5"
                                />
                              </div>
                              <div>
                                <label className="mb-1.5 block text-xs font-medium text-ink">
                                  Cache sentinel nodes
                                </label>
                                {renderHostPortRows(
                                  formData.falkordbConnection.cache.sentinelNodes,
                                  (next) => updateCache({ sentinelNodes: next }),
                                  26379,
                                )}
                              </div>
                            </>
                          )}

                          <label className="flex items-center justify-between rounded-lg border border-glass-border bg-black/5 px-3 py-2 dark:bg-white/5">
                            <p className="text-xs font-medium text-ink">Use TLS for the dedicated cache</p>
                            <input
                              type="checkbox"
                              checked={formData.falkordbConnection.cache.tlsEnabled}
                              onChange={(event) => updateCache({ tlsEnabled: event.target.checked })}
                              className="h-4 w-4 rounded border-glass-border text-indigo-500 focus:ring-indigo-500/50"
                            />
                          </label>

                          {formData.falkordbConnection.cache.tlsEnabled && (
                            <div className="space-y-3 rounded-lg border border-glass-border bg-black/5 p-3 dark:bg-white/5">
                              <div>
                                <label className="mb-1.5 block text-xs font-medium text-ink">
                                  Cache CA certificate path <span className="text-ink-muted">(optional)</span>
                                </label>
                                <input
                                  value={formData.falkordbConnection.cache.tlsCaCertPath}
                                  onChange={(event) => updateCache({ tlsCaCertPath: event.target.value })}
                                  placeholder="/certs/cache/ca.crt"
                                  className="w-full rounded-lg border border-glass-border bg-black/5 px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50 dark:bg-white/5"
                                />
                              </div>
                              <div className="grid grid-cols-2 gap-3">
                                <div>
                                  <label className="mb-1.5 block text-xs font-medium text-ink">
                                    Cache client cert path <span className="text-ink-muted">(mTLS)</span>
                                  </label>
                                  <input
                                    value={formData.falkordbConnection.cache.tlsCertPath}
                                    onChange={(event) => updateCache({ tlsCertPath: event.target.value })}
                                    placeholder="/certs/cache/client.crt"
                                    className="w-full rounded-lg border border-glass-border bg-black/5 px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50 dark:bg-white/5"
                                  />
                                </div>
                                <div>
                                  <label className="mb-1.5 block text-xs font-medium text-ink">
                                    Cache client key path <span className="text-ink-muted">(mTLS)</span>
                                  </label>
                                  <input
                                    value={formData.falkordbConnection.cache.tlsKeyPath}
                                    onChange={(event) => updateCache({ tlsKeyPath: event.target.value })}
                                    placeholder="/certs/cache/client.key"
                                    className="w-full rounded-lg border border-glass-border bg-black/5 px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50 dark:bg-white/5"
                                  />
                                </div>
                              </div>
                              <div className="grid grid-cols-2 gap-3">
                                <div>
                                  <label className="mb-1.5 block text-xs font-medium text-ink">Cache verify mode</label>
                                  <select
                                    value={formData.falkordbConnection.cache.tlsVerifyMode}
                                    onChange={(event) =>
                                      updateCache({
                                        tlsVerifyMode: event.target.value as CacheConnectionState['tlsVerifyMode'],
                                      })
                                    }
                                    className="w-full rounded-lg border border-glass-border bg-black/5 px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50 dark:bg-white/5"
                                  >
                                    <option value="required">Required (verify server)</option>
                                    <option value="optional">Optional</option>
                                    <option value="none">None (self-signed)</option>
                                  </select>
                                </div>
                                <label className="flex items-end gap-2 pb-2 text-xs text-ink">
                                  <input
                                    type="checkbox"
                                    checked={formData.falkordbConnection.cache.tlsCheckHostname}
                                    onChange={(event) => updateCache({ tlsCheckHostname: event.target.checked })}
                                    className="h-4 w-4 rounded border-glass-border text-indigo-500 focus:ring-indigo-500/50"
                                  />
                                  Check hostname
                                </label>
                              </div>
                            </div>
                          )}
                        </div>
                      )
                    )}
                  </div>
      )}

      {/* Node-identity DEFAULT for every source on this provider. Lives here
          rather than on the (Neo4j/Spanner-only) schema-mapping step because it
          applies to every provider type -- and the provider is usually the right
          level for it: one connection's graphs are almost always shaped alike. */}
      <NodeIdentityField
        scope="provider"
        canEdit
        value={formData.identityProperty}
        onChange={(v) => updateFormData({ identityProperty: v })}
        nameValue={formData.nameProperty}
        onNameChange={(v) => updateFormData({ nameProperty: v })}
      />
    </div>
  )

  const renderSchemaStep = () => (
    <div className="space-y-6">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex items-start gap-3"
      >
        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl border border-violet-500/10 bg-gradient-to-br from-violet-500/20 to-indigo-500/20">
          <BookOpen className="h-5 w-5 text-violet-500" />
        </div>
        <div>
          <h3 className="text-lg font-semibold text-ink">Optional schema mapping</h3>
          <p className="mt-0.5 text-sm text-ink-muted">
            If your Neo4j graph uses custom property names, map them now so later ingestion steps feel native.
          </p>
        </div>
      </motion.div>

      <div className="rounded-2xl border border-glass-border bg-canvas-elevated p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h4 className="text-sm font-semibold text-ink">Enable custom mapping</h4>
            <p className="mt-1 text-xs text-ink-muted">
              Skip this if your graph already follows {appName}’s default schema conventions.
            </p>
          </div>
          <label className="relative inline-flex cursor-pointer items-center">
            <input
              type="checkbox"
              checked={formData.schemaMappingEnabled}
              onChange={(event) => updateFormData({ schemaMappingEnabled: event.target.checked })}
              className="peer sr-only"
            />
            <div className="h-5 w-9 rounded-full bg-black/10 transition-colors after:absolute after:left-[2px] after:top-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-transform after:content-[''] peer-checked:bg-indigo-500 peer-checked:after:translate-x-full dark:bg-white/10" />
          </label>
        </div>

        <AnimatePresence initial={false}>
          {formData.schemaMappingEnabled ? (
            <motion.div
              key="schema-enabled"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              className="mt-5 space-y-4"
            >
              <button
                type="button"
                onClick={handleDiscoverSchema}
                disabled={schemaLoading || !formData.host}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-500/10 px-4 py-2.5 text-sm font-semibold text-indigo-600 transition-colors hover:bg-indigo-500/20 disabled:opacity-50 dark:text-indigo-400"
              >
                {schemaLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Scan className="h-4 w-4" />}
                {schemaLoading ? 'Discovering schema...' : 'Auto-discover mapping'}
              </button>

              {schemaError && (
                <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-500">
                  {schemaError}
                </div>
              )}

              {schemaDiscovery && (
                <div className="rounded-2xl border border-glass-border bg-black/[0.02] p-4 dark:bg-white/[0.02]">
                  <div className="mb-3 flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-indigo-500" />
                    <h5 className="text-xs font-bold uppercase tracking-wider text-ink-muted">Discovered schema</h5>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {schemaDiscovery.labels.map((label) => (
                      <span key={label} className="rounded-full border border-blue-500/20 bg-blue-500/10 px-2 py-0.5 text-[11px] font-medium text-blue-600 dark:text-blue-400">
                        {label}
                      </span>
                    ))}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {schemaDiscovery.relationshipTypes.map((relationshipType) => (
                      <span key={relationshipType} className="rounded-full border border-violet-500/20 bg-violet-500/10 px-2 py-0.5 text-[11px] font-medium text-violet-600 dark:text-violet-400">
                        {relationshipType}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div className="space-y-3">
                {([
                  ['identityField', 'Identity (URN)', 'The property used as the stable unique identifier'],
                  ['displayNameField', 'Display Name', 'Human-readable label for the entity'],
                  ['qualifiedNameField', 'Qualified Name', 'The full hierarchical or technical path name'],
                  ['descriptionField', 'Description', 'Description or notes field'],
                  ['tagsField', 'Tags', 'Tags or classifications field'],
                ] as const).map(([fieldKey, label, hint]) => (
                  <div key={fieldKey} className="grid grid-cols-1 gap-2 md:grid-cols-5 md:items-center">
                    <div className="md:col-span-2">
                      <label className="text-xs font-medium text-ink">{label}</label>
                      <p className="mt-0.5 text-[10px] leading-tight text-ink-muted">{hint}</p>
                    </div>
                    <div className="hidden justify-center text-ink-muted md:col-span-1 md:flex">
                      <ArrowRight className="h-3 w-3" />
                    </div>
                    <div className="md:col-span-2">
                      <input
                        value={formData.schemaMapping[fieldKey]}
                        onChange={(event) => setFormData((previous) => ({
                          ...previous,
                          schemaMapping: {
                            ...previous.schemaMapping,
                            [fieldKey]: event.target.value,
                          },
                        }))}
                        className="w-full rounded-lg border border-glass-border bg-black/5 px-3 py-2 text-xs font-mono text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50 dark:bg-white/5"
                      />
                    </div>
                  </div>
                ))}
              </div>

              <div className="rounded-xl border border-glass-border bg-black/5 p-4 dark:bg-white/5">
                <label className="mb-2 block text-xs font-medium text-ink">Entity type resolution</label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setFormData((previous) => ({
                      ...previous,
                      schemaMapping: { ...previous.schemaMapping, entityTypeStrategy: 'label' },
                    }))}
                    className={cn(
                      'flex-1 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors',
                      formData.schemaMapping.entityTypeStrategy === 'label'
                        ? 'border-indigo-500/30 bg-indigo-500/10 text-indigo-600'
                        : 'border-glass-border text-ink-muted hover:text-ink',
                    )}
                  >
                    Use label
                  </button>
                  <button
                    type="button"
                    onClick={() => setFormData((previous) => ({
                      ...previous,
                      schemaMapping: { ...previous.schemaMapping, entityTypeStrategy: 'property' },
                    }))}
                    className={cn(
                      'flex-1 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors',
                      formData.schemaMapping.entityTypeStrategy === 'property'
                        ? 'border-indigo-500/30 bg-indigo-500/10 text-indigo-600'
                        : 'border-glass-border text-ink-muted hover:text-ink',
                    )}
                  >
                    Use property
                  </button>
                </div>
                {formData.schemaMapping.entityTypeStrategy === 'property' && (
                  <input
                    value={formData.schemaMapping.entityTypeField}
                    onChange={(event) => setFormData((previous) => ({
                      ...previous,
                      schemaMapping: { ...previous.schemaMapping, entityTypeField: event.target.value },
                    }))}
                    placeholder="entityType"
                    className="mt-3 w-full rounded-lg border border-glass-border bg-white/60 px-3 py-2 text-xs font-mono text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50 dark:bg-black/10"
                  />
                )}
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="schema-default"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              className="mt-5 rounded-xl border border-emerald-500/20 bg-emerald-500/8 px-4 py-4 text-sm text-emerald-700 dark:text-emerald-300"
            >
              {appName} will assume the default property names such as <code className="rounded bg-emerald-500/10 px-1.5 py-0.5 font-mono text-xs">urn</code>, <code className="rounded bg-emerald-500/10 px-1.5 py-0.5 font-mono text-xs">displayName</code>, and <code className="rounded bg-emerald-500/10 px-1.5 py-0.5 font-mono text-xs">entityType</code>.
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )

  const renderReviewStep = () => (
    <div className="mx-auto w-full max-w-2xl space-y-8">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="text-center"
      >
        <div className="mb-4 inline-flex items-center gap-2 rounded-full bg-indigo-500/10 px-4 py-2 text-sm font-medium text-indigo-600 dark:text-indigo-400">
          <Sparkles className="h-4 w-4" />
          {mode === 'edit' ? 'Ready to save changes' : 'Ready to register provider'}
        </div>
        <h3 className="text-2xl font-bold text-slate-900 dark:text-white">
          Review your provider configuration
        </h3>
        <p className="mt-2 text-slate-500">
          Confirm the infrastructure details below before {appName} validates the connection.
        </p>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.08 }}
        className="mx-auto w-full overflow-hidden rounded-2xl border border-glass-border bg-canvas-elevated shadow-sm"
      >
        <div className="divide-y divide-glass-border">
          <div className="p-6">
            <div className="mb-4 flex items-center gap-3">
              <div className={cn('flex h-11 w-11 items-center justify-center rounded-xl border shadow-sm', currentConfig.color)}>
                <currentConfig.Logo className="h-5 w-5" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium uppercase tracking-wide text-slate-500">Provider</p>
                <p className="font-semibold text-slate-800 dark:text-slate-200">{formData.name || 'Unnamed provider'}</p>
              </div>
              <Check className="h-5 w-5 text-green-500" />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800">
                {currentConfig.label}
              </span>
              <span className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-sm font-mono dark:border-slate-700 dark:bg-slate-800">
                {formData.host || 'localhost'}:{formData.port}
              </span>
              {formData.tlsEnabled && (
                <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1.5 text-sm text-emerald-600 dark:text-emerald-400">
                  TLS enabled
                </span>
              )}
            </div>
          </div>

          <div className="p-6">
            <div className="mb-4 flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-100 text-indigo-600 shadow-sm dark:bg-indigo-900/30 dark:text-indigo-400">
                <Globe className="h-5 w-5" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium uppercase tracking-wide text-slate-500">Access</p>
                <p className="font-semibold text-slate-800 dark:text-slate-200">
                  {(formData.providerType !== 'falkordb' || (formData.falkordbConnection?.authEnabled ?? true)) && (formData.password || formData.username)
                    ? 'Credentials supplied'
                    : 'Anonymous / host-only access'}
                </p>
              </div>
              <Check className="h-5 w-5 text-green-500" />
            </div>
            <p className="text-sm text-slate-500">
              {(formData.providerType !== 'falkordb' || (formData.falkordbConnection?.authEnabled ?? true)) && (formData.password || formData.username)
                ? (formData.username
                    ? `The provider will be created with username ${formData.username}.`
                    : `The provider will be created with password-only authentication (default user).`)
                : `No credentials were entered. ${appName} will connect with the host and port settings only.`}
            </p>
          </div>

          <div className="p-6">
            <div className="mb-4 flex items-center gap-3">
              <div className={cn(
                'flex h-11 w-11 items-center justify-center rounded-xl shadow-sm',
                connectivityCheck.state === 'success'
                  ? 'bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400'
                  : connectivityCheck.state === 'failure'
                    ? 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400'
                    : 'bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400',
              )}>
                {connectivityCheck.state === 'success' ? (
                  <CheckCircle2 className="h-5 w-5" />
                ) : connectivityCheck.state === 'failure' ? (
                  <AlertTriangle className="h-5 w-5" />
                ) : (
                  <Zap className="h-5 w-5" />
                )}
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium uppercase tracking-wide text-slate-500">Connectivity</p>
                <p className="font-semibold text-slate-800 dark:text-slate-200">
                  {connectivityCheck.state === 'success'
                    ? 'Connected successfully'
                    : connectivityCheck.state === 'failure'
                      ? 'Unable to connect'
                      : connectivityCheck.state === 'checking'
                        ? 'Testing connection...'
                        : mode === 'create'
                          ? 'Connection check required before creating this provider.'
                          : 'Connection test not run in this session.'}
                </p>
              </div>
              {connectivityCheck.result?.latencyMs !== undefined && (
                <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-mono text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
                  {connectivityCheck.result.latencyMs}ms
                </span>
              )}
            </div>
            <div className={cn(
              'rounded-xl border px-4 py-3.5 text-sm leading-relaxed',
              connectivityCheck.state === 'success'
                ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                : connectivityCheck.state === 'failure'
                  ? 'border-red-500/20 bg-red-500/10 text-red-600 dark:text-red-300'
                  : 'border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300',
            )}>
              {connectivityCheck.state === 'success'
                ? 'The provider responded to a live connectivity probe. You can create it safely now.'
                : connectivityCheck.state === 'failure'
                  ? connectivityCheck.result?.error || 'Connection test failed.'
                  : connectivityCheck.state === 'checking'
                    ? `${appName} is probing the provider now. This should only take a few seconds.`
                    : mode === 'create'
                      ? 'Run a live connection test before creating the provider so you know these settings are reachable.'
                      : 'Save changes as-is, or test the PENDING settings now — the per-row Test button on the provider list probes the last saved config, not unsaved edits.'}
            </div>
            {(mode === 'edit' || connectivityCheck.state !== 'idle') && (
              <div className="mt-3 flex justify-end">
                <button
                  type="button"
                  onClick={handleTestConnection}
                  disabled={connectivityCheck.state === 'checking'}
                  className="inline-flex items-center gap-2 rounded-lg border border-glass-border bg-white/70 px-3 py-2 text-sm font-medium text-ink-secondary transition-colors hover:bg-white dark:bg-slate-900/40 dark:hover:bg-slate-900/70"
                >
                  {connectivityCheck.state === 'checking' ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                  {connectivityCheck.state === 'failure'
                    ? 'Retry connection test'
                    : connectivityCheck.state === 'idle'
                      ? 'Test pending settings'
                      : 'Test again'}
                </button>
              </div>
            )}
          </div>

          {formData.providerType === 'neo4j' && (
            <div className="p-6">
              <div className="mb-4 flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-violet-100 text-violet-600 shadow-sm dark:bg-violet-900/30 dark:text-violet-400">
                  <BookOpen className="h-5 w-5" />
                </div>
                <div className="flex-1">
                  <p className="text-sm font-medium uppercase tracking-wide text-slate-500">Schema Mapping</p>
                  <p className="font-semibold text-slate-800 dark:text-slate-200">
                    {formData.schemaMappingEnabled ? 'Custom mapping enabled' : `Default ${appName} schema`}
                  </p>
                </div>
                <Check className="h-5 w-5 text-green-500" />
              </div>
              {formData.schemaMappingEnabled ? (
                <div className="grid gap-2 text-sm text-slate-500">
                  <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-800">
                    <span>Identity</span>
                    <code className="font-mono text-slate-800 dark:text-slate-200">{formData.schemaMapping.identityField}</code>
                  </div>
                  <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-800">
                    <span>Display name</span>
                    <code className="font-mono text-slate-800 dark:text-slate-200">{formData.schemaMapping.displayNameField}</code>
                  </div>
                  <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-800">
                    <span>Entity type resolution</span>
                    <code className="font-mono text-slate-800 dark:text-slate-200">{formData.schemaMapping.entityTypeStrategy}</code>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-slate-500">
                  The default {appName} property names will be used for this provider.
                </p>
              )}
            </div>
          )}
        </div>
      </motion.div>
    </div>
  )

  const renderSuccessPhase = () => {
    if (!createdProvider || !connectionResult) return null

    const healthy = connectionResult.success
    return (
      <div className="max-w-2xl space-y-8">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center"
        >
          <div className={cn(
            'mb-4 inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium',
            healthy
              ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
              : 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
          )}>
            {healthy ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
            {healthy ? 'Provider connected' : 'Provider created with warnings'}
          </div>
          <h3 className="text-2xl font-bold text-slate-900 dark:text-white">
            {healthy ? `${createdProvider.name} is ready` : `${createdProvider.name} needs attention`}
          </h3>
          <p className="mt-2 text-slate-500">
            {healthy
              ? 'Continue straight into data source discovery, or stay on the providers screen to manage more infrastructure.'
              : connectionResult.error || 'The provider was saved, but the connection test did not pass.'}
          </p>
        </motion.div>

        <div className="grid gap-3 md:grid-cols-2">
          <button
            type="button"
            onClick={() => {
              onClose()
              navigate(`/ingestion?tab=assets&provider=${createdProvider.id}&onboarding=true`)
            }}
            className={cn(
              'rounded-2xl border p-5 text-left transition-[colors,transform,box-shadow] duration-150 hover:-translate-y-0.5 hover:shadow-md',
              healthy
                ? 'border-indigo-500/30 bg-indigo-500/8'
                : 'border-glass-border bg-canvas-elevated opacity-60',
            )}
            disabled={!healthy}
          >
            <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-500/10 text-indigo-500">
              <Database className="h-5 w-5" />
            </div>
            <h4 className="text-base font-semibold text-ink">Discover data sources</h4>
            <p className="mt-2 text-sm text-ink-muted">
              Move directly into asset onboarding for this provider.
            </p>
          </button>

          <button
            type="button"
            onClick={onClose}
            className="rounded-2xl border border-glass-border bg-canvas-elevated p-5 text-left transition-[colors,transform,box-shadow] duration-150 hover:-translate-y-0.5 hover:shadow-md"
          >
            <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-black/5 text-ink dark:bg-white/5">
              <Pencil className="h-5 w-5" />
            </div>
            <h4 className="text-base font-semibold text-ink">Back to providers</h4>
            <p className="mt-2 text-sm text-ink-muted">
              Stay on the registry page and continue managing provider infrastructure.
            </p>
          </button>
        </div>

        {!healthy && (
          <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 px-5 py-4 text-sm text-amber-700 dark:text-amber-300">
            You can edit this provider from the registry once you’ve checked its host, port, credentials, or TLS settings.
          </div>
        )}
      </div>
    )
  }

  return (
    <>
      <Backdrop open={true} zClassName="z-[100]" className="bg-black/80" />
      <div className="fixed inset-0 z-[100] flex items-center justify-center px-4 py-6 pointer-events-none">
        <div
          ref={modalRef}
          className="pointer-events-auto flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-3xl border border-glass-border bg-canvas-elevated shadow-lg animate-in zoom-in-95 duration-200"
        >
          <div className="flex items-center justify-between border-b border-glass-border px-6 py-4">
            <div>
              <h2 className="text-lg font-bold text-ink">
                {mode === 'edit' ? `Edit ${provider?.name ?? 'Provider'}` : 'Provider Onboarding'}
              </h2>
              <p className="mt-0.5 text-sm text-ink-muted">
                {wizardPhase === 'success'
                  ? 'Provider created'
                  : `Step ${currentStepIndex + 1} of ${steps.length}: ${activeStep?.title ?? 'Provider setup'}`}
              </p>
            </div>
            <div className="flex items-center gap-1">
              <DocsLink slug="admin-setup" variant="icon" />
              <button
                type="button"
                onClick={handleClose}
                className="rounded-lg p-2 text-ink-muted transition-colors hover:bg-black/5 hover:text-ink dark:hover:bg-white/5"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>

          {wizardPhase === 'steps' && (
            <div className="flex items-center gap-2 border-b border-glass-border px-6 py-3">
              {steps.map((step, index) => {
                const StepIcon = step.icon
                const isComplete = index < currentStepIndex
                const isCurrent = index === currentStepIndex

                return (
                  <div key={step.id} className="flex items-center gap-2">
                    {index > 0 && (
                      <div className={cn(
                        'h-0.5 w-8 rounded-full',
                        isComplete ? 'bg-indigo-500' : 'bg-glass-border',
                      )} />
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        if (index < currentStepIndex) {
                          setPreviousSteps(steps.slice(0, index).map((item) => item.id))
                          setCurrentStep(step.id)
                        }
                      }}
                      className={cn(
                        'flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium transition-colors duration-150',
                        isComplete
                          ? 'bg-indigo-500/10 text-indigo-500'
                          : isCurrent
                            ? 'bg-indigo-500 text-white shadow-md shadow-indigo-500/25'
                            : 'bg-black/5 text-ink-muted dark:bg-white/5',
                      )}
                    >
                      {isComplete ? <Check className="h-3 w-3" /> : <StepIcon className="h-3 w-3" />}
                      <span className="hidden sm:inline">{step.title}</span>
                    </button>
                  </div>
                )
              })}
            </div>
          )}

          <div className="flex-1 overflow-y-auto px-6 py-5 min-h-[480px]">
            {wizardPhase === 'steps' && <StepWarnings warnings={stepWarnings} />}

            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={wizardPhase === 'success' ? 'success' : currentStep}
                initial={{ opacity: 0, x: 18 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -18 }}
                transition={{ duration: 0.2 }}
                className="mt-4"
              >
                {wizardPhase === 'success'
                  ? renderSuccessPhase()
                  : currentStep === 'type'
                    ? renderTypeStep()
                    : currentStep === 'connection'
                      ? renderConnectionStep()
                      : currentStep === 'schema'
                        ? renderSchemaStep()
                        : renderReviewStep()}
              </motion.div>
            </AnimatePresence>

            {submitError && (
              <div className="mt-4 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-500">
                {submitError}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between border-t border-glass-border px-6 py-4">
            {wizardPhase === 'steps' ? (
              <>
                <button
                  type="button"
                  onClick={currentStepIndex === 0 ? handleClose : goBack}
                  className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-ink-secondary transition-colors hover:bg-black/5 hover:text-ink dark:hover:bg-white/5"
                >
                  <ChevronLeft className="h-4 w-4" />
                  {currentStepIndex === 0 ? 'Cancel' : 'Back'}
                </button>

                <button
                  type="button"
                  onClick={isLastStep ? primaryAction : goNext}
                  disabled={!canProceed || isSubmitting || (shouldRunConnectivityTest && connectivityCheck.state === 'checking')}
                  className={cn(
                    'flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold transition-[colors,box-shadow] duration-150',
                    isLastStep
                      ? 'bg-gradient-to-r from-indigo-500 to-violet-600 text-white shadow-md hover:shadow-lg disabled:opacity-50'
                      : 'bg-indigo-500/10 text-indigo-500 hover:bg-indigo-500/20 disabled:opacity-50',
                  )}
                >
                  {isSubmitting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : isLastStep ? (
                    <>
                      {shouldRunConnectivityTest ? (
                        connectivityCheck.state === 'failure' ? (
                          <RefreshCw className="h-4 w-4" />
                        ) : (
                          <Zap className="h-4 w-4" />
                        )
                      ) : (
                        <Zap className="h-4 w-4" />
                      )}
                      {mode === 'edit'
                        ? 'Save changes'
                        : shouldRunConnectivityTest
                          ? 'Test connection'
                          : 'Create provider'}
                    </>
                  ) : (
                    <>
                      Next
                      <ChevronRight className="h-4 w-4" />
                    </>
                  )}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-lg px-4 py-2 text-sm font-medium text-ink-secondary transition-colors hover:bg-black/5 hover:text-ink dark:hover:bg-white/5"
                >
                  Done
                </button>
                {connectionResult?.success && createdProvider && (
                  <button
                    type="button"
                    onClick={() => {
                      onClose()
                      navigate(`/ingestion?tab=assets&provider=${createdProvider.id}&onboarding=true`)
                    }}
                    className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-600 px-5 py-2.5 text-sm font-semibold text-white shadow-md transition-[colors,box-shadow] duration-150 hover:shadow-lg"
                  >
                    <Plus className="h-4 w-4" />
                    Continue to data sources
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      <ConfirmCloseDialog
        isOpen={showCloseConfirm}
        onCancel={() => setShowCloseConfirm(false)}
        onConfirm={confirmClose}
      />
    </>
  )
}
