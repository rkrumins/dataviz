/**
 * Setting up the Playground (platform administrators): its name, the sandbox provider
 * its blank graphs go on — kept apart from production — the starter data models its
 * members may begin from, and how many graphs each person may have.
 */
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import { FlaskConical, Loader2, X } from 'lucide-react'
import { providerService } from '@/services/providerService'
import { ontologyDefinitionService } from '@/services/ontologyDefinitionService'
import type { PlaygroundInfo } from '@/services/playgroundService'
import { useSetUpPlayground } from '@/hooks/usePlayground'
import { useModalA11y } from '@/hooks/useModalA11y'
import { useAppNotifications } from '@/components/ui/notifications'
import { Backdrop } from '@/components/ui/Backdrop'
import { Button } from '@/components/ui/Button'

export function PlaygroundSetupDialog({ info, onClose }: { info: PlaygroundInfo; onClose: () => void }) {
    const { notify } = useAppNotifications()
    const ref = useModalA11y(true, onClose)
    const setUp = useSetUpPlayground()
    const providers = useQuery({ queryKey: ['providers', 'list'], queryFn: () => providerService.list(), staleTime: 300_000 }).data ?? []
    const ontologies = useQuery({ queryKey: ['ontology-defs', 'list'], queryFn: () => ontologyDefinitionService.list(), staleTime: 300_000 }).data ?? []
    const sandboxes = providers.filter((p) => String(p.providerType).toLowerCase() === 'falkordb')
    const published = ontologies.filter((o) => o.isPublished)

    const [name, setName] = useState(info.name || 'Playground')
    const [provider, setProvider] = useState(info.sandboxProviderId ?? '')
    const [starters, setStarters] = useState<string[]>(info.starterOntologyIds ?? [])
    const [quota, setQuota] = useState(info.graphQuota || 5)

    const save = () => setUp.mutate(
        { name: name.trim() || 'Playground', sandboxProviderId: provider, starterOntologyIds: starters, graphQuota: quota },
        {
            onSuccess: () => { notify('success', info.exists ? 'Playground settings saved.' : 'The Playground is ready for people to join.'); onClose() },
            onError: (e) => notify('error', e instanceof Error ? e.message : 'Couldn’t save the Playground.'),
        },
    )

    return createPortal(
        <>
            <Backdrop open onClick={onClose} zClassName="z-[60]" />
            <div className="fixed inset-0 z-[61] flex items-center justify-center p-4 pointer-events-none">
                <div
                    ref={ref}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="playground-setup-title"
                    tabIndex={-1}
                    className="pointer-events-auto w-full max-w-lg rounded-3xl border border-glass-border bg-canvas-elevated shadow-2xl outline-none"
                >
                    <div className="flex items-start gap-3 p-6 pb-4">
                        <span className="w-10 h-10 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white flex items-center justify-center shrink-0">
                            <FlaskConical className="w-5 h-5" aria-hidden />
                        </span>
                        <div className="min-w-0 flex-1">
                            <h2 id="playground-setup-title" className="text-lg font-bold text-ink">{info.exists ? 'Playground settings' : 'Set up the Playground'}</h2>
                            <p className="text-sm text-ink-muted">Anyone who can sign in may join and build graphs here — never with production data.</p>
                        </div>
                        <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1 text-ink-muted hover:text-ink"><X className="w-4 h-4" /></button>
                    </div>

                    <div className="space-y-4 px-6 pb-2">
                        <label className="block">
                            <span className="text-xs font-semibold text-ink-secondary">Name</span>
                            <input value={name} onChange={(e) => setName(e.target.value)} className="input mt-1 w-full" />
                        </label>
                        <label className="block">
                            <span className="text-xs font-semibold text-ink-secondary">Sandbox provider</span>
                            <select value={provider} onChange={(e) => setProvider(e.target.value)} className="input mt-1 w-full">
                                <option value="">Choose a FalkorDB provider…</option>
                                {sandboxes.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                            </select>
                            <span className="mt-1 block text-[11px] text-ink-muted">Every graph built in the Playground goes here. Give it a provider of its own, kept apart from production.</span>
                        </label>
                        <fieldset>
                            <legend className="text-xs font-semibold text-ink-secondary">Starter data models</legend>
                            <span className="block text-[11px] text-ink-muted">What members may start a graph from.</span>
                            <div className="mt-1.5 max-h-40 overflow-y-auto custom-scrollbar space-y-1 rounded-xl border border-glass-border p-2">
                                {published.length === 0 && <p className="text-xs text-ink-muted p-1">No published data models yet.</p>}
                                {published.map((o) => (
                                    <label key={o.id} className="flex items-center gap-2 rounded-lg px-2 py-1 text-sm text-ink hover:bg-black/[0.03] dark:hover:bg-white/[0.04]">
                                        <input type="checkbox" checked={starters.includes(o.id)}
                                            onChange={(e) => setStarters(e.target.checked ? [...starters, o.id] : starters.filter((x) => x !== o.id))} />
                                        {o.name} <span className="text-[11px] text-ink-muted">v{o.version}</span>
                                    </label>
                                ))}
                            </div>
                        </fieldset>
                        <label className="block">
                            <span className="text-xs font-semibold text-ink-secondary">Graphs per person</span>
                            <input type="number" min={1} max={100} value={quota} onChange={(e) => setQuota(Math.max(1, Math.min(100, Number(e.target.value) || 1)))}
                                className="input mt-1 w-28" />
                            <span className="mt-1 block text-[11px] text-ink-muted">Experiments don’t expire; this is the only limit.</span>
                        </label>
                    </div>

                    <div className="flex justify-end gap-2 p-6 pt-4">
                        <Button variant="ghost" onClick={onClose}>Cancel</Button>
                        <Button variant="primary" onClick={save} disabled={!provider || setUp.isPending}>
                            {setUp.isPending && <Loader2 className="w-4 h-4 animate-spin" aria-hidden />}
                            {info.exists ? 'Save' : 'Set up the Playground'}
                        </Button>
                    </div>
                </div>
            </div>
        </>,
        document.body,
    )
}
