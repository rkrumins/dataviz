/**
 * AdvancedDrawer — power-user concerns, tucked behind the gear.
 *
 *   ┌── ← Back ────────────── Options | JSON | Cypher ────┐
 *   │                                                     │
 *   │   {active tab content}                              │
 *   │                                                     │
 *   └─────────────────────────────────────────────────────┘
 *
 * Composing filters happens in the Query card on the main surface
 * (rows + Visual/Code toggle). The drawer holds only the three
 * power-user concerns that don't belong on the primary surface:
 *
 *   - **Options** — group-by aggregation, page size, candidate cap,
 *     include-ancestor-path. Live tuning the QueryCard never touches.
 *   - **JSON** — the literal Predicate DSL, validated. Read + edit.
 *     Use this for OR / NOT / path composition the row UI can't
 *     express yet.
 *   - **Cypher** — the exact query FalkorDB will run, with bound
 *     parameters and any diagnostic notes from the resolver.
 *     Always-visible, no nested toggles.
 *
 * The legacy "Builder" tab is gone — the Query card on the main
 * panel is the single visual builder so users learn one pattern
 * instead of two competing ones.
 */
import { ArrowLeft } from 'lucide-react'
import { type FC, type ReactNode, useState } from 'react'

import { cn } from '@/lib/utils'
import { useSchemaStore } from '@/store/schema'

import { JsonEditorView } from '../JsonEditorView'
import { useDiscovery } from '../builder/useDiscovery'

import { CypherView } from './CypherView'
import { OptionsPanel } from './OptionsPanel'


export type DrawerTab = 'builder' | 'options' | 'json' | 'cypher'


export interface AdvancedDrawerProps {
    viewId: string
    onClose: () => void
    /** Open the drawer on this tab. Defaults to 'options'.
     *
     *  ``'builder'`` is still accepted for backwards compatibility
     *  with older call sites; it now routes to ``'json'`` since the
     *  visual builder lives on the main panel.
     */
    initialTab?: DrawerTab
}


export const AdvancedDrawer: FC<AdvancedDrawerProps> = ({
    viewId, onClose, initialTab = 'options',
}) => {
    const resolved: Exclude<DrawerTab, 'builder'> =
        initialTab === 'builder' ? 'json' : initialTab
    const [tab, setTab] = useState<Exclude<DrawerTab, 'builder'>>(resolved)
    const knownEntityTypes = useEntityTypeNames()
    const { allKeys } = useDiscovery(viewId)

    return (
        <div className="flex flex-col h-full min-h-0">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-glass-border/60">
                <button
                    type="button"
                    onClick={onClose}
                    className={cn(
                        'inline-flex items-center gap-1.5 px-2 py-1 rounded-lg',
                        'text-[11.5px] font-medium text-ink-muted hover:text-ink',
                        'hover:bg-glass/40 transition-colors',
                    )}
                >
                    <ArrowLeft className="w-3.5 h-3.5" />
                    Back
                </button>
                <div className="ml-auto inline-flex rounded-lg bg-canvas-base/40 border border-glass-border/60 p-0.5">
                    <TabBtn active={tab === 'options'} onClick={() => setTab('options')}>
                        Options
                    </TabBtn>
                    <TabBtn active={tab === 'json'} onClick={() => setTab('json')}>
                        JSON
                    </TabBtn>
                    <TabBtn active={tab === 'cypher'} onClick={() => setTab('cypher')}>
                        Cypher
                    </TabBtn>
                </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-4 py-4">
                {tab === 'options' && (
                    <div className="rounded-2xl border border-glass-border bg-canvas-base/30 p-3.5">
                        <OptionsPanel
                            knownEntityTypes={knownEntityTypes}
                            knownPropertyKeys={allKeys}
                        />
                    </div>
                )}
                {tab === 'json' && (
                    <div className="rounded-2xl border border-glass-border bg-canvas-base/30 p-3.5 min-h-[260px]">
                        <JsonEditorView
                            onBack={() => { /* no-op */ }}
                            onRun={() => { /* run from the Query card */ }}
                            isRunning={false}
                        />
                    </div>
                )}
                {tab === 'cypher' && (
                    <CypherView viewId={viewId} />
                )}
            </div>
        </div>
    )
}


function TabBtn({
    active, onClick, children,
}: { active: boolean; onClick: () => void; children: ReactNode }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                'px-3 py-1 rounded-md text-[11px] font-semibold transition-colors',
                active
                    ? 'bg-accent-lineage/20 text-accent-lineage'
                    : 'text-ink-muted hover:text-ink',
            )}
        >
            {children}
        </button>
    )
}


function useEntityTypeNames(): string[] {
    const schema = useSchemaStore((s) => s.schema)
    if (!schema?.entityTypes) return []
    return schema.entityTypes.map((t) => t.id)
}
