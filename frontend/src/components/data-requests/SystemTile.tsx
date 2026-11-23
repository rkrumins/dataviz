/** A data request's system: its icon on its coloured tile (`systems`). */
import type { DataRequestSystem } from '@/services/dataRequestsService'
import { systemOf } from './systems'

export function SystemTile({ system, size = 'md' }: { system: DataRequestSystem | string; size?: 'sm' | 'md' | 'lg' }) {
    const s = systemOf(system)
    const Icon = s.icon
    const box = size === 'lg' ? 'h-11 w-11 rounded-2xl' : size === 'sm' ? 'h-8 w-8 rounded-lg' : 'h-9 w-9 rounded-xl'
    const glyph = size === 'lg' ? 'h-5 w-5' : 'h-4 w-4'
    return (
        <span aria-hidden className={`flex shrink-0 items-center justify-center ${box} ${s.tile} ${s.tone}`}>
            <Icon className={glyph} />
        </span>
    )
}
