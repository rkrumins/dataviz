/**
 * The three read modes, as an administrator chooses between them: what a graph's readers get while
 * a newer version of it is written into the graph store. One source for the platform's default (the
 * New-version builds card) and a graph's own choice (its read mode dialog), so both say the same.
 *
 * Each mode says, in the reader's terms: its promise; what readers see before, while and after
 * version 6 lands (``frames``); a worked example on a large graph; what it is good for, what it
 * costs, and what it needs.
 */
import type { LucideIcon } from 'lucide-react'
import { Database, Layers, Zap } from 'lucide-react'
import type { ReadMode } from '@/services/systemStatusService'

/** One moment of the timeline: the version readers see, and where it comes from. */
export interface ReadFrame {
    when: 'Before' | 'While version 6 lands' | 'After'
    /** The version shown: 5, 6, or a mix of both while the new one is written in place. */
    shows: '5' | '6' | 'mix'
    /** Where reads come from at that moment. */
    from: 'graph store' | 'database'
    note?: string
}

export interface ReadModeInfo {
    mode: ReadMode
    title: string
    short: string
    icon: LucideIcon
    promise: string
    frames: ReadFrame[]
    example: string
    goodFor: string
    pros: string[]
    cons: string[]
    needs: string
}

export const READ_MODES: ReadModeInfo[] = [
    {
        mode: 'latest',
        title: 'Always the latest',
        short: 'Always the latest',
        icon: Database,
        promise: 'Readers see the newest published version the moment it is published, read from the database until the graph store has it.',
        frames: [
            { when: 'Before', shows: '5', from: 'graph store' },
            { when: 'While version 6 lands', shows: '6', from: 'database', note: 'Newest version, read from the database: slower' },
            { when: 'After', shows: '6', from: 'graph store' },
        ],
        example: 'An import changes 100,000 items in a graph of 10 million. Within seconds of the publish, canvases show version 6, '
            + 'read from the database while the graph store catches up: large views load slower, lineage summaries are missing '
            + 'until it has, and under heavy load a read may be asked to retry.',
        goodFor: 'The default, as reads have always worked. Small or critical graphs where the newest data matters more than speed.',
        pros: ['Always the newest version, even mid-update', 'Nothing extra to run or watch'],
        cons: ['Reads during an update come from the database: slower on large graphs', 'Lineage summaries are missing until the graph store catches up'],
        needs: 'Database capacity for reading whole graphs while they update.',
    },
    {
        mode: 'in_place',
        title: 'Keep serving, update in place',
        short: 'Update in place',
        icon: Zap,
        promise: 'Readers keep the version they have, at full speed, while the next one is written into the same copy.',
        frames: [
            { when: 'Before', shows: '5', from: 'graph store' },
            { when: 'While version 6 lands', shows: 'mix', from: 'graph store', note: 'Version 5, with parts of 6 as they are written' },
            { when: 'After', shows: '6', from: 'graph store' },
        ],
        example: 'An import changes 100,000 items in a graph of 10 million. Canvases stay fast and keep showing version 5; '
            + 'as version 6 is written, its changes appear a batch at a time; once it is all in, every view shows version 6.',
        goodFor: 'Large graphs whose views must stay fast while big imports land, where a moment of a partly applied change is fine.',
        pros: ['Reads stay fast throughout', 'No extra memory'],
        cons: ['During a large update, readers can see some of the new version before the rest of it'],
        needs: 'Nothing extra.',
    },
    {
        mode: 'beside',
        title: 'Keep serving, switch when ready',
        short: 'Switch when ready',
        icon: Layers,
        promise: 'Readers keep exactly the version they have while the next one is built in a second copy, then everyone switches at once.',
        frames: [
            { when: 'Before', shows: '5', from: 'graph store' },
            { when: 'While version 6 lands', shows: '5', from: 'graph store', note: 'Exactly version 5; version 6 is built alongside' },
            { when: 'After', shows: '6', from: 'graph store', note: 'Switched in one step, once built and checked' },
        ],
        example: 'An import changes 100,000 items in a graph of 10 million. Canvases keep showing exactly version 5 while version 6 '
            + 'is built and checked in a second copy; then every view switches to version 6 at once. If the build fails, '
            + 'nobody sees it: version 5 stays.',
        goodFor: 'Large graphs with big imports, where everyone should see one complete version at a time.',
        pros: ['Readers always see one complete version', 'Reads stay fast; a failed update is never shown'],
        cons: ['The new version shows only once it is fully built, so later than in place', 'Takes room for a second copy while it is built'],
        needs: 'Free memory on a graph store node for a second copy of the graph, and New-version builds turned on.',
    },
]

export const READ_MODE: Record<ReadMode, ReadModeInfo> =
    Object.fromEntries(READ_MODES.map(m => [m.mode, m])) as Record<ReadMode, ReadModeInfo>
