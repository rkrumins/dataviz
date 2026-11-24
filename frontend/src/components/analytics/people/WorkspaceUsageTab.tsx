/**
 * The People view, fixed to one workspace, for the workspace page's Usage tab.
 *
 * Its range is the tab's own and lives in the URL beside the tab (`urange`, or
 * `ufrom`/`uto`), so a link to "who used Atlas in March" survives a reload.
 */
import { useSearchParams } from 'react-router-dom'

import type { AnalyticsRangeSelection } from '@/services/analyticsService'
import {
    DEFAULT_RANGE_DAYS, RANGE_PRESETS, RangePicker, customRangeError,
} from '../RangePicker'
import { PeopleTab } from './PeopleTab'

export function WorkspaceUsageTab({ workspaceId }: { workspaceId: string }) {
    const [params, setParams] = useSearchParams()
    const raw = Number(params.get('urange'))
    const from = params.get('ufrom')
    const to = params.get('uto')
    const range: AnalyticsRangeSelection = from && to && !customRangeError(from, to)
        ? { kind: 'custom', from, to }
        : { kind: 'preset', days: RANGE_PRESETS.some((p) => p.days === raw) ? raw : DEFAULT_RANGE_DAYS }

    const setRange = (next: AnalyticsRangeSelection) => {
        const out = new URLSearchParams(params)
        out.delete('urange'); out.delete('ufrom'); out.delete('uto')
        if (next.kind === 'custom') { out.set('ufrom', next.from); out.set('uto', next.to) }
        else out.set('urange', String(next.days))
        setParams(out, { replace: true })
    }

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                    <h2 className="text-base font-bold text-ink">Who uses this workspace</h2>
                    <p className="text-xs text-ink-muted">
                        Each member’s activity here, day by day — who joined when, who is active, and who has gone quiet. Days in UTC.
                    </p>
                </div>
                <RangePicker range={range} onChange={setRange} />
            </div>
            <PeopleTab range={range} onRangeChange={setRange} workspaceId={workspaceId} />
        </div>
    )
}
