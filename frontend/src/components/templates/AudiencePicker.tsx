/**
 * Who a template is for: Personal, a Workspace, or the whole Organization.
 *
 * A tile this person cannot choose stays visible and says why — "ask an
 * administrator" is a route, a missing tile is a mystery. The server makes the
 * final call (`template_access.creation_refusal`); this mirrors it so nobody is
 * offered a click that fails.
 */
import { Check } from 'lucide-react'
import { HoverTip } from '@/components/ui/HoverTip'
import { cn } from '@/lib/utils'
import type { TemplateVisibility } from '@/services/layoutTemplateService'
import { useAuthStore } from '@/store/auth'
import { useBrand } from '@/store/branding'
import { useWorkspacesStore } from '@/store/workspaces'
import { AUDIENCE, CHOOSABLE, audienceDescription } from './templateAudience'

export const MANAGE_TEMPLATES = 'system:templates:manage'

export function AudiencePicker({ visibility, workspaceId, onChange, disabled }: {
    visibility: TemplateVisibility
    workspaceId: string | null
    onChange: (next: { visibility: TemplateVisibility; workspaceId: string | null }) => void
    disabled?: boolean
}) {
    const { appName } = useBrand()
    const can = useAuthStore(s => s.can)
    const workspaces = useWorkspacesStore(s => s.workspaces)
    const eligible = workspaces.filter(ws => can('workspace:view:create', ws.id))
    const isManager = can(MANAGE_TEMPLATES)
    const selectedWs = workspaces.find(ws => ws.id === workspaceId)

    const refusal = (v: TemplateVisibility): string | null => {
        if (v === 'workspace' && eligible.length === 0) {
            return "You can't add templates to any of your workspaces. A workspace admin can give you that."
        }
        if (v === 'enterprise' && !isManager) {
            return 'Offering a template to everyone needs the Manage templates permission. Ask an administrator.'
        }
        return null
    }

    return (
        <div className="space-y-3">
            <div role="radiogroup" aria-label="Who can use this template" className="grid gap-3 sm:grid-cols-3">
                {CHOOSABLE.map(({ visibility: v, audience }) => {
                    const meta = AUDIENCE[audience]
                    const Icon = meta.icon
                    const why = refusal(v)
                    const selected = visibility === v
                    const tile = (
                        <button
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            disabled={disabled || !!why}
                            onClick={() => onChange({
                                visibility: v,
                                workspaceId: v === 'workspace' ? (workspaceId ?? eligible[0]?.id ?? null) : null,
                            })}
                            className={cn(
                                'relative flex flex-col items-start w-full h-full text-left rounded-2xl border-2 p-4 transition-colors',
                                selected ? meta.tile : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600',
                                (disabled || why) && 'opacity-50 cursor-not-allowed hover:border-slate-200 dark:hover:border-slate-700',
                            )}
                        >
                            {selected && (
                                <span className="absolute top-3 right-3 w-5 h-5 rounded-full bg-indigo-500 flex items-center justify-center">
                                    <Check className="w-3 h-3 text-white" />
                                </span>
                            )}
                            <Icon className="w-5 h-5 text-ink-secondary mb-2" />
                            <div className="text-sm font-bold text-ink">{meta.label}</div>
                            <p className="text-xs text-ink-muted mt-1 leading-snug">
                                {audienceDescription(audience, {
                                    appName, workspaceName: v === 'workspace' ? selectedWs?.name : undefined,
                                })}
                            </p>
                        </button>
                    )
                    return why ? (
                        <HoverTip key={v} label={why} className="block h-full">{tile}</HoverTip>
                    ) : <div key={v} className="h-full">{tile}</div>
                })}
            </div>

            {visibility === 'workspace' && eligible.length > 0 && (
                <label className="flex items-center gap-3 text-sm">
                    <span className="text-xs font-semibold uppercase tracking-wider text-ink-muted shrink-0">Workspace</span>
                    <select
                        value={workspaceId ?? ''}
                        disabled={disabled}
                        onChange={e => onChange({ visibility, workspaceId: e.target.value || null })}
                        className="input border-slate-200 dark:border-slate-700 h-9 text-sm flex-1 bg-glass-base/40"
                    >
                        {eligible.map(ws => <option key={ws.id} value={ws.id}>{ws.name}</option>)}
                    </select>
                </label>
            )}
        </div>
    )
}
