import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
    Server, Plus, RefreshCw, Wifi, WifiOff, Edit2, Trash2, Zap,
    Shield, Globe, ChevronDown, ChevronUp, Loader2, Scan, ArrowRight, AlertTriangle
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { providerService, type ProviderResponse, type ProviderCreateRequest, type ProviderUpdateRequest, type ProviderImpactResponse, type SchemaDiscoveryResult } from '@/services/providerService'
import { AdminWizard, type WizardStep } from './AdminWizard'
import { DeleteProviderDialog } from './DeleteProviderDialog'
import { Neo4jLogo, FalkorDBLogo, DataHubLogo, MockLogo } from './ProviderLogos'

const PROVIDER_TYPES = [
    { type: 'falkordb' as const, label: 'FalkorDB', Logo: FalkorDBLogo, color: 'text-amber-500 bg-amber-500/10 border-amber-500/20', desc: 'High-performance graph database' },
    { type: 'neo4j' as const, label: 'Neo4j', Logo: Neo4jLogo, color: 'text-blue-500 bg-blue-500/10 border-blue-500/20', desc: 'The original graph database' },
    { type: 'datahub' as const, label: 'DataHub', Logo: DataHubLogo, color: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/20', desc: 'LinkedIn metadata platform' },
    { type: 'mock' as const, label: 'Mock', Logo: MockLogo, color: 'text-violet-500 bg-violet-500/10 border-violet-500/20', desc: 'Testing & development' },
]

function getProviderConfig(type: string) {
    return PROVIDER_TYPES.find(p => p.type === type) || PROVIDER_TYPES[3]
}

type HealthStatus = 'checking' | 'healthy' | 'unhealthy' | 'unknown'
interface ProviderHealth { status: HealthStatus; latencyMs?: number; error?: string }

function ConnectionCard({ provider, health, onTest, onEdit, onDelete, onScan }: { provider: ProviderResponse; health: ProviderHealth; onTest: () => void; onEdit: () => void; onDelete: () => void; onScan: () => void }) {
    const config = getProviderConfig(provider.providerType)
    const [expanded, setExpanded] = useState(false)
    const statusDot = { checking: 'bg-amber-400 animate-pulse', healthy: 'bg-emerald-400', unhealthy: 'bg-red-400', unknown: 'bg-gray-400' }[health.status]

    return (
        <div className={cn("group border border-glass-border rounded-xl bg-canvas-elevated hover:shadow-lg transition-all duration-200", health.status === 'healthy' && "hover:border-emerald-500/30", health.status === 'unhealthy' && "border-red-500/20")}>
            <div className="p-5">
                <div className="flex items-start justify-between mb-4">
                    <div className="flex items-center gap-3">
                        <div className={cn("w-10 h-10 rounded-xl border flex items-center justify-center", config.color)}><config.Logo className="w-5 h-5" /></div>
                        <div>
                            <h3 className="text-sm font-bold text-ink">{provider.name}</h3>
                            <p className="text-xs text-ink-muted">{config.label}</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <div className={cn("w-2.5 h-2.5 rounded-full", statusDot)} title={health.status} />
                        {health.latencyMs !== undefined && <span className="text-[10px] font-mono text-ink-muted">{Math.round(health.latencyMs)}ms</span>}
                    </div>
                </div>
                <div className="flex items-center gap-4 text-xs text-ink-muted mb-4">
                    {provider.host && <div className="flex items-center gap-1.5"><Globe className="w-3 h-3" /><span className="font-mono">{provider.host}:{provider.port || '—'}</span></div>}
                    {provider.tlsEnabled && <div className="flex items-center gap-1 text-emerald-500"><Shield className="w-3 h-3" /><span>TLS</span></div>}
                </div>
                <div className="flex items-center gap-2">
                    <button onClick={onTest} disabled={health.status === 'checking'} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 text-ink-secondary hover:text-ink transition-colors disabled:opacity-50">
                        {health.status === 'checking' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />} Test
                    </button>
                    <button onClick={onScan} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-600 dark:text-indigo-400 transition-colors"><RefreshCw className="w-3 h-3" /> Discover Assets</button>
                    <button onClick={onEdit} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 text-ink-secondary hover:text-ink transition-colors"><Edit2 className="w-3 h-3" /> Edit</button>
                    <button onClick={onDelete} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg text-red-500 hover:bg-red-500/10 transition-colors ml-auto"><Trash2 className="w-3 h-3" /></button>
                    <button onClick={() => setExpanded(!expanded)} className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-ink-muted transition-colors">
                        {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    </button>
                </div>
            </div>
            {expanded && (
                <div className="px-5 pb-5 pt-3 border-t border-glass-border animate-in slide-in-from-top-2 fade-in duration-200">
                    <dl className="grid grid-cols-2 gap-3 text-xs">
                        <div><dt className="text-ink-muted font-medium">Provider ID</dt><dd className="font-mono text-ink mt-0.5 truncate">{provider.id}</dd></div>
                        <div><dt className="text-ink-muted font-medium">Status</dt><dd className={cn("mt-0.5 font-semibold", provider.isActive ? "text-emerald-500" : "text-red-500")}>{provider.isActive ? 'Active' : 'Inactive'}</dd></div>
                        <div><dt className="text-ink-muted font-medium">Created</dt><dd className="text-ink mt-0.5">{new Date(provider.createdAt).toLocaleDateString()}</dd></div>
                        <div><dt className="text-ink-muted font-medium">Last Updated</dt><dd className="text-ink mt-0.5">{new Date(provider.updatedAt).toLocaleDateString()}</dd></div>
                        {health.error && <div className="col-span-2"><dt className="text-red-500 font-medium">Error</dt><dd className="text-red-400 mt-0.5 font-mono text-[11px] break-all">{health.error}</dd></div>}
                    </dl>
                </div>
            )}
        </div>
    )
}

export function RegistryConnections() {
    const navigate = useNavigate()
    const [providers, setProviders] = useState<ProviderResponse[]>([])
    const [healthMap, setHealthMap] = useState<Record<string, ProviderHealth>>({})
    const [isLoading, setIsLoading] = useState(true)
    const [showWizard, setShowWizard] = useState(false)

    // Wizard form state
    const [wizType, setWizType] = useState<string>('')
    const [wizName, setWizName] = useState('')
    const [wizHost, setWizHost] = useState('')
    const [wizPort, setWizPort] = useState<number>(6379)
    const [wizTls, setWizTls] = useState(false)
    const [wizUsername, setWizUsername] = useState('')
    const [wizPassword, setWizPassword] = useState('')
    const [wizSubmitting, setWizSubmitting] = useState(false)
    const [editingProvider, setEditingProvider] = useState<ProviderResponse | null>(null)
    const [deleteTarget, setDeleteTarget] = useState<ProviderResponse | null>(null)
    const [deleteImpact, setDeleteImpact] = useState<ProviderImpactResponse | null>(null)
    const [loadingImpact, setLoadingImpact] = useState(false)

    const wizNameDuplicate = providers.some(p =>
        p.name.toLowerCase() === wizName.trim().toLowerCase() && p.id !== editingProvider?.id
    )

    // Schema mapping state (Neo4j / external DBs)
    const [schemaDiscovery, setSchemaDiscovery] = useState<SchemaDiscoveryResult | null>(null)
    const [schemaLoading, setSchemaLoading] = useState(false)
    const [schemaError, setSchemaError] = useState('')
    const [schemaMapping, setSchemaMapping] = useState<Record<string, string>>({
        identityField: 'urn',
        displayNameField: 'displayName',
        qualifiedNameField: 'qualifiedName',
        descriptionField: 'description',
        tagsField: 'tags',
        entityTypeStrategy: 'label',
        entityTypeField: 'entityType',
    })
    const [schemaMappingEnabled, setSchemaMappingEnabled] = useState(false)

    const loadProviders = useCallback(async () => {
        setIsLoading(true)
        try {
            const data = await providerService.list()
            setProviders(data)
        } catch (err) { console.error('Failed to load providers', err) }
        finally { setIsLoading(false) }
    }, [])

    useEffect(() => { loadProviders() }, [loadProviders])
    useEffect(() => {
        if (!providers.length) return
        providers.forEach(p => testProvider(p.id))
    }, [providers.length]) // eslint-disable-line react-hooks/exhaustive-deps

    const testProvider = async (id: string) => {
        setHealthMap(prev => ({ ...prev, [id]: { status: 'checking' } }))
        try {
            const result = await providerService.test(id)
            setHealthMap(prev => ({ ...prev, [id]: { status: result.success ? 'healthy' : 'unhealthy', latencyMs: result.latencyMs, error: result.error } }))
        } catch {
            setHealthMap(prev => ({ ...prev, [id]: { status: 'unhealthy', error: 'Connection test failed' } }))
        }
    }

    const handleDeleteClick = async (p: ProviderResponse) => {
        setDeleteTarget(p)
        setLoadingImpact(true)
        try {
            const impact = await providerService.getImpact(p.id)
            setDeleteImpact(impact)
        } catch (err) {
            console.error('Failed to load impact', err)
        } finally {
            setLoadingImpact(false)
        }
    }

    const deleteProvider = async () => {
        if (!deleteTarget) return
        try { await providerService.delete(deleteTarget.id) } catch (err) { console.error('Failed to delete provider', err) }
        setDeleteTarget(null)
        setDeleteImpact(null)
        loadProviders()
    }

    const resetWizard = () => {
        setWizType(''); setWizName(''); setWizHost(''); setWizPort(6379)
        setWizTls(false); setWizUsername(''); setWizPassword('')
        setSchemaDiscovery(null); setSchemaLoading(false); setSchemaError('')
        setSchemaMappingEnabled(false)
        setSchemaMapping({
            identityField: 'urn', displayNameField: 'displayName', qualifiedNameField: 'qualifiedName',
            descriptionField: 'description', tagsField: 'tags', entityTypeStrategy: 'label', entityTypeField: 'entityType',
        })
    }


    const buildExtraConfig = () => {
        if (!schemaMappingEnabled) return undefined
        return {
            schemaMapping: {
                identity_field: schemaMapping.identityField,
                display_name_field: schemaMapping.displayNameField,
                qualified_name_field: schemaMapping.qualifiedNameField,
                description_field: schemaMapping.descriptionField,
                tags_field: schemaMapping.tagsField,
                entity_type_strategy: schemaMapping.entityTypeStrategy,
                entity_type_field: schemaMapping.entityTypeField,
            },
        }
    }

    const handleWizardComplete = async () => {
        setWizSubmitting(true)
        try {
            const req: ProviderCreateRequest = {
                name: wizName, providerType: wizType as any, host: wizHost || undefined, port: wizPort || undefined, tlsEnabled: wizTls,
                credentials: (wizUsername || wizPassword) ? { username: wizUsername || undefined, password: wizPassword || undefined } : undefined,
                extraConfig: buildExtraConfig(),
            }
            const newlyCreated = await providerService.create(req)
            setShowWizard(false)
            resetWizard()
            loadProviders()

            // Health gate: test connection before navigating
            const health = await providerService.test(newlyCreated.id)
            setHealthMap(prev => ({ ...prev, [newlyCreated.id]: { status: health.success ? 'healthy' : 'unhealthy', latencyMs: health.latencyMs, error: health.error } }))

            if (health.success) {
                navigate(`/admin/registry?tab=assets&provider=${newlyCreated.id}&onboarding=true`)
            }
        } catch (err) { console.error('Failed to create provider', err) }
        finally { setWizSubmitting(false) }
    }

    const handleEditComplete = async () => {
        if (!editingProvider) return
        setWizSubmitting(true)
        try {
            const req: ProviderUpdateRequest = {
                name: wizName, host: wizHost || undefined, port: wizPort || undefined, tlsEnabled: wizTls,
                credentials: (wizUsername || wizPassword) ? { username: wizUsername || undefined, password: wizPassword || undefined } : undefined,
                extraConfig: buildExtraConfig(),
            }
            await providerService.update(editingProvider.id, req)
            setShowWizard(false); setEditingProvider(null); resetWizard(); loadProviders()
        } catch (err) { console.error('Failed to update provider', err) }
        finally { setWizSubmitting(false) }
    }

    const handleEditProvider = (p: ProviderResponse) => {
        setEditingProvider(p); setWizType(p.providerType); setWizName(p.name); setWizHost(p.host || ''); setWizPort(p.port || 6379)
        setWizTls(p.tlsEnabled); setWizUsername(''); setWizPassword('')
        // Restore schema mapping from extraConfig if present
        const existingMapping = p.extraConfig?.schemaMapping
        if (existingMapping) {
            setSchemaMappingEnabled(true)
            setSchemaMapping({
                identityField: existingMapping.identity_field || 'urn',
                displayNameField: existingMapping.display_name_field || 'displayName',
                qualifiedNameField: existingMapping.qualified_name_field || 'qualifiedName',
                descriptionField: existingMapping.description_field || 'description',
                tagsField: existingMapping.tags_field || 'tags',
                entityTypeStrategy: existingMapping.entity_type_strategy || 'label',
                entityTypeField: existingMapping.entity_type_field || 'entityType',
            })
        }
        setShowWizard(true)
    }

    const wizardSteps: WizardStep[] = [
        {
            id: 'type', title: 'Provider Type', icon: Server, validate: () => wizType ? true : 'Please select a provider type.',
            content: (
                <div className="grid grid-cols-2 gap-3">
                    {PROVIDER_TYPES.map(pt => (
                        <button key={pt.type} onClick={() => { setWizType(pt.type); if (pt.type === 'falkordb') setWizPort(6379); else if (pt.type === 'neo4j') setWizPort(7687); }}
                            className={cn("p-5 rounded-xl border-2 text-left transition-all duration-200 hover:shadow-md", wizType === pt.type ? "border-indigo-500 bg-indigo-500/5 shadow-md shadow-indigo-500/10" : "border-glass-border hover:border-indigo-500/30")}
                        >
                            <pt.Logo className="w-7 h-7 mb-2" /><h4 className="text-sm font-bold text-ink">{pt.label}</h4><p className="text-xs text-ink-muted mt-1">{pt.desc}</p>
                        </button>
                    ))}
                </div>
            ),
        },
        {
            id: 'connection', title: 'Connection Details', icon: Globe, validate: () => wizName && !wizNameDuplicate ? true : !wizName ? 'Please enter a name for this provider.' : 'A provider with this name already exists.',
            content: (
                <div className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-ink mb-1.5">Connection Name *</label>
                        <input value={wizName} onChange={e => setWizName(e.target.value)} placeholder="e.g. Production Data Warehouse" className="w-full px-4 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-indigo-500/50" />
                        {wizNameDuplicate && (
                            <p className="mt-1.5 text-xs text-amber-500 flex items-center gap-1">
                                <AlertTriangle className="w-3 h-3" />
                                A provider named "{wizName.trim()}" already exists
                            </p>
                        )}
                    </div>
                    <div className="grid grid-cols-3 gap-3">
                        <div className="col-span-2"><label className="block text-sm font-medium text-ink mb-1.5">Host</label><input value={wizHost} onChange={e => setWizHost(e.target.value)} placeholder="localhost" className="w-full px-4 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50" /></div>
                        <div><label className="block text-sm font-medium text-ink mb-1.5">Port</label><input type="number" value={wizPort} onChange={e => setWizPort(Number(e.target.value))} className="w-full px-4 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50" /></div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        <div><label className="block text-sm font-medium text-ink mb-1.5">Username</label><input value={wizUsername} onChange={e => setWizUsername(e.target.value)} placeholder="optional" className="w-full px-4 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50" /></div>
                        <div><label className="block text-sm font-medium text-ink mb-1.5">Password</label><input type="password" value={wizPassword} onChange={e => setWizPassword(e.target.value)} placeholder="optional" className="w-full px-4 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50" /></div>
                    </div>
                </div>
            ),
        },
        // Schema Mapping step — only for Neo4j and external databases
        ...(wizType === 'neo4j' ? [{
            id: 'schema-mapping',
            title: 'Schema Mapping',
            icon: Scan,
            validate: () => true as boolean | string,
            content: (
                <div className="space-y-5">
                    <div className="flex items-center justify-between">
                        <div>
                            <h4 className="text-sm font-bold text-ink">Property Schema Mapping</h4>
                            <p className="text-xs text-ink-muted mt-1">
                                Map your Neo4j property names to Synodic's canonical model. Skip this if your database already uses Synodic's schema.
                            </p>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                            <input type="checkbox" checked={schemaMappingEnabled} onChange={e => setSchemaMappingEnabled(e.target.checked)} className="sr-only peer" />
                            <div className="w-9 h-5 bg-black/10 dark:bg-white/10 peer-checked:bg-indigo-500 rounded-full transition-colors after:content-[''] after:absolute after:top-0.5 after:left-[2px] peer-checked:after:translate-x-full after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all" />
                        </label>
                    </div>

                    {schemaMappingEnabled && (
                        <>
                            {/* Discover button */}
                            <button
                                onClick={async () => {
                                    setSchemaLoading(true); setSchemaError('')
                                    try {
                                        // Create a temporary provider to discover schema
                                        const tempReq: ProviderCreateRequest = {
                                            name: `_temp_discovery_${Date.now()}`, providerType: 'neo4j',
                                            host: wizHost || 'localhost', port: wizPort || 7687, tlsEnabled: wizTls,
                                            credentials: { username: wizUsername || undefined, password: wizPassword || undefined },
                                        }
                                        const temp = await providerService.create(tempReq)
                                        try {
                                            const result = await providerService.discoverSchema(temp.id)
                                            setSchemaDiscovery(result)
                                            // Auto-apply suggested mapping if available
                                            if (result.suggestedMapping) {
                                                const s = result.suggestedMapping
                                                setSchemaMapping(prev => ({
                                                    ...prev,
                                                    identityField: s.identity_field || prev.identityField,
                                                    displayNameField: s.display_name_field || prev.displayNameField,
                                                    qualifiedNameField: s.qualified_name_field || prev.qualifiedNameField,
                                                    descriptionField: s.description_field || prev.descriptionField,
                                                    entityTypeStrategy: s.entity_type_strategy || prev.entityTypeStrategy,
                                                }))
                                            }
                                        } finally {
                                            // Clean up temp provider
                                            await providerService.delete(temp.id).catch(() => {})
                                        }
                                    } catch (err: any) {
                                        setSchemaError(err.message || 'Failed to discover schema')
                                    } finally {
                                        setSchemaLoading(false)
                                    }
                                }}
                                disabled={schemaLoading || !wizHost}
                                className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 text-sm font-semibold hover:bg-indigo-500/20 transition-colors disabled:opacity-50 w-full justify-center"
                            >
                                {schemaLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Scan className="w-4 h-4" />}
                                {schemaLoading ? 'Introspecting Database...' : 'Auto-Discover Schema'}
                            </button>

                            {schemaError && (
                                <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-red-500">{schemaError}</div>
                            )}

                            {/* Discovery results preview */}
                            {schemaDiscovery && (
                                <div className="p-4 rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.02] space-y-2">
                                    <h5 className="text-xs font-bold text-ink-muted uppercase tracking-wider">Discovered Schema</h5>
                                    <div className="flex flex-wrap gap-1.5">
                                        {schemaDiscovery.labels.map(l => (
                                            <span key={l} className="px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 text-[11px] font-medium border border-blue-500/20">{l}</span>
                                        ))}
                                    </div>
                                    <div className="flex flex-wrap gap-1.5 mt-1">
                                        {schemaDiscovery.relationshipTypes.map(r => (
                                            <span key={r} className="px-2 py-0.5 rounded-full bg-violet-500/10 text-violet-600 dark:text-violet-400 text-[11px] font-medium border border-violet-500/20">{r}</span>
                                        ))}
                                    </div>
                                    {schemaDiscovery.labelDetails && Object.keys(schemaDiscovery.labelDetails).length > 0 && (
                                        <div className="mt-2 text-xs text-ink-muted">
                                            {Object.entries(schemaDiscovery.labelDetails).slice(0, 3).map(([label, detail]) => (
                                                <div key={label} className="mt-1">
                                                    <span className="font-semibold text-ink">{label}</span>
                                                    <span className="ml-1">({detail.count} nodes)</span>
                                                    <span className="ml-1 text-ink-muted">— props: {detail.propertyKeys.join(', ')}</span>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Mapping fields */}
                            <div className="space-y-3">
                                <h5 className="text-xs font-bold text-ink-muted uppercase tracking-wider">Field Mapping</h5>
                                {([
                                    ['identityField', 'Identity (URN)', 'The property used as unique identifier'],
                                    ['displayNameField', 'Display Name', 'Human-readable name property'],
                                    ['qualifiedNameField', 'Qualified Name', 'Fully qualified path name'],
                                    ['descriptionField', 'Description', 'Description / notes property'],
                                    ['tagsField', 'Tags', 'Tags array property (JSON string or list)'],
                                ] as const).map(([key, label, hint]) => (
                                    <div key={key} className="grid grid-cols-5 gap-2 items-center">
                                        <div className="col-span-2">
                                            <label className="text-xs font-medium text-ink">{label}</label>
                                            <p className="text-[10px] text-ink-muted leading-tight">{hint}</p>
                                        </div>
                                        <div className="col-span-1 flex items-center justify-center text-ink-muted">
                                            <ArrowRight className="w-3 h-3" />
                                        </div>
                                        <div className="col-span-2">
                                            <input
                                                value={schemaMapping[key]}
                                                onChange={e => setSchemaMapping(prev => ({ ...prev, [key]: e.target.value }))}
                                                className="w-full px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 border border-glass-border text-xs font-mono text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                                            />
                                        </div>
                                    </div>
                                ))}

                                {/* Entity type strategy */}
                                <div className="pt-2 border-t border-glass-border">
                                    <label className="text-xs font-medium text-ink block mb-2">Entity Type Resolution</label>
                                    <div className="flex gap-2">
                                        <button
                                            onClick={() => setSchemaMapping(prev => ({ ...prev, entityTypeStrategy: 'label' }))}
                                            className={cn("flex-1 px-3 py-2 rounded-lg border text-xs font-semibold transition-colors",
                                                schemaMapping.entityTypeStrategy === 'label' ? "bg-indigo-500/10 border-indigo-500/30 text-indigo-600" : "border-glass-border text-ink-muted hover:text-ink")}
                                        >
                                            From Neo4j Label
                                        </button>
                                        <button
                                            onClick={() => setSchemaMapping(prev => ({ ...prev, entityTypeStrategy: 'property' }))}
                                            className={cn("flex-1 px-3 py-2 rounded-lg border text-xs font-semibold transition-colors",
                                                schemaMapping.entityTypeStrategy === 'property' ? "bg-indigo-500/10 border-indigo-500/30 text-indigo-600" : "border-glass-border text-ink-muted hover:text-ink")}
                                        >
                                            From Property
                                        </button>
                                    </div>
                                    {schemaMapping.entityTypeStrategy === 'property' && (
                                        <input
                                            value={schemaMapping.entityTypeField}
                                            onChange={e => setSchemaMapping(prev => ({ ...prev, entityTypeField: e.target.value }))}
                                            placeholder="entityType"
                                            className="mt-2 w-full px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 border border-glass-border text-xs font-mono text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                                        />
                                    )}
                                </div>
                            </div>
                        </>
                    )}

                    {!schemaMappingEnabled && (
                        <div className="p-4 rounded-xl bg-emerald-500/5 border border-emerald-500/20 text-sm text-emerald-600 dark:text-emerald-400">
                            Using default Synodic schema. Your Neo4j database should use properties like <code className="font-mono text-xs bg-emerald-500/10 px-1 py-0.5 rounded">urn</code>, <code className="font-mono text-xs bg-emerald-500/10 px-1 py-0.5 rounded">displayName</code>, <code className="font-mono text-xs bg-emerald-500/10 px-1 py-0.5 rounded">entityType</code>.
                        </div>
                    )}
                </div>
            ),
        }] : []),
        {
            id: 'review', title: 'Review & Save', icon: Shield, validate: () => true as boolean | string,
            content: (
                <div className="space-y-4">
                    <div className="rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.02] p-5">
                        <h4 className="text-sm font-bold text-ink mb-3">Connection Summary</h4>
                        <dl className="grid grid-cols-2 gap-3 text-sm">
                            <div><dt className="text-ink-muted">Type</dt><dd className="font-semibold text-ink mt-0.5">{getProviderConfig(wizType).label}</dd></div>
                            <div><dt className="text-ink-muted">Name</dt><dd className="font-semibold text-ink mt-0.5">{wizName || '—'}</dd></div>
                            <div><dt className="text-ink-muted">Host</dt><dd className="font-mono text-ink mt-0.5">{wizHost || 'localhost'}:{wizPort}</dd></div>
                            {schemaMappingEnabled && (
                                <div className="col-span-2">
                                    <dt className="text-ink-muted">Schema Mapping</dt>
                                    <dd className="font-mono text-ink mt-0.5 text-xs">
                                        {schemaMapping.identityField} → urn, {schemaMapping.displayNameField} → displayName
                                    </dd>
                                </div>
                            )}
                        </dl>
                    </div>
                </div>
            ),
        },
    ]

    const healthyCount = Object.values(healthMap).filter(h => h.status === 'healthy').length
    const unhealthyCount = Object.values(healthMap).filter(h => h.status === 'unhealthy').length

    return (
        <div className="space-y-6 animate-in fade-in duration-500">
            {/* Header / Actions */}
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-xl font-bold text-ink">Physical Connections</h2>
                    <p className="text-sm text-ink-muted mt-1">Manage database clusters and catalog availability.</p>
                </div>
                <button onClick={() => { resetWizard(); setShowWizard(true) }} className="flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-500 hover:bg-indigo-600 text-white text-sm font-semibold transition-colors">
                    <Plus className="w-4 h-4" /> Register Connection
                </button>
            </div>

            {/* Health Summary */}
            {providers.length > 0 && (
                <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-xs font-medium">
                        <Wifi className="w-3 h-3" /> {healthyCount} Connected
                    </div>
                    {unhealthyCount > 0 && (
                        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-red-500/10 text-red-500 text-xs font-medium">
                            <WifiOff className="w-3 h-3" /> {unhealthyCount} Disconnected
                        </div>
                    )}
                    <button onClick={() => providers.forEach(p => testProvider(p.id))} className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium text-ink-muted hover:text-ink transition-colors ml-auto">
                        <RefreshCw className="w-3 h-3" /> Re-test All
                    </button>
                </div>
            )}

            {/* Grid */}
            {isLoading ? (
                <div className="flex justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-ink-muted" /></div>
            ) : providers.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-20 border-2 border-dashed border-glass-border rounded-2xl">
                    <Server className="w-12 h-12 text-ink-muted mb-4" />
                    <h3 className="text-lg font-bold text-ink mb-1">No connections</h3>
                    <p className="text-sm text-ink-muted">Connect your first database to begin.</p>
                </div>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {providers.map(p => (
                        <ConnectionCard key={p.id} provider={p} health={healthMap[p.id] || { status: 'unknown' }} onTest={() => testProvider(p.id)} onEdit={() => handleEditProvider(p)} onDelete={() => handleDeleteClick(p)} onScan={() => navigate(`/admin/registry?tab=assets&provider=${p.id}`)} />
                    ))}
                </div>
            )}

            <AdminWizard title={editingProvider ? `Edit ${editingProvider.name}` : 'Register Connection'} steps={wizardSteps} isOpen={showWizard} onClose={() => { setShowWizard(false); setEditingProvider(null); resetWizard() }} onComplete={editingProvider ? handleEditComplete : handleWizardComplete} isSubmitting={wizSubmitting} completionLabel={editingProvider ? 'Save Changes' : 'Connect'} />

            <DeleteProviderDialog
                provider={deleteTarget}
                impact={deleteImpact}
                loadingImpact={loadingImpact}
                isOpen={!!deleteTarget}
                onClose={() => { setDeleteTarget(null); setDeleteImpact(null) }}
                onConfirm={deleteProvider}
            />

        </div>
    )
}

