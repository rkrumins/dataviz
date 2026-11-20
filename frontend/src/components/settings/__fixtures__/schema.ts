/**
 * The registry as the schema endpoint serves it to this fixture's platform: the generated catalogue
 * (`src/generated/versionedGraphSettings.json`, so labels, guidance and choices are production's),
 * with the parts the server renders from live values and facts: "for this platform"
 * recommendations, examples worked with the platform's values, and the category postures.
 *
 * Those live parts were produced by the registry itself, `schema_json(values, facts)` in
 * `backend/app/config/versioned_graph_settings.py`, with the values of `PLATFORM_VALUES` and the
 * facts of `FACTS` (resolved.ts): three nodes of 12, 16 and 12 GB at 9.1, 3.2 and 10.8 GB used, a
 * 9.4 GB largest graph, 4 graphs per worker, 10 connections per process and 3 reader processes.
 */
import { CATALOGUE } from '../catalogue'
import type { Recommended, Setting, SettingsSchema } from '../types'

const FOR_THIS_PLATFORM: Record<string, Recommended['forThisPlatform']> = {
    'builds.copyRoomPct': { value: 220, why: 'Your largest graph (9.4 GB) needs 20.7 GB free to copy; your roomiest node, Node 2, has 9.6 GB under its start mark. Keep 220%: a copy was measured at 2.0 times the graph\'s memory at its peak. With Auto, its builds come from the database instead, which needs about half the memory.' },
    'builds.copyMaxBytes': { value: 4093640704, why: 'Your roomiest node, Node 2, has 9.6 GB free under its start mark: enough to copy graphs up to 3.8 GB at 250%. A copy of your largest graph (9.4 GB) needs 23.5 GB. A limit of 3.8 GB builds larger graphs from the database from the start, which needs about half the memory.' },
    'builds.perWorker': { value: 2, why: 'Each worker updates 4 graphs at once, and builds count among them; 2 at a time keeps big changes moving without taking every turn. No node has room to copy your largest graph now, so its builds are made from the database or wait.' },
    'residency.unloadStartPct': { value: 80, why: 'At 80%, Node 3 starts unloading at 9.6 GB used. Node 3, your fullest node, is at 90%: past the mark, so graphs there are being unloaded. A load of your largest graph asks for 12.2 GB.' },
    'residency.unloadStopPct': { value: 70, why: 'A load of your largest graph (12.2 GB) takes 102 points of Node 1\'s memory (12 GB): freeing that much every round would unload graphs people use. Keep 70%; a load of it makes room as it needs, unloading the graphs read longest ago.' },
    'database.readsPerGraph': { value: 4, why: 'Half of the 8 reads each process runs from the database: one graph takes at most half, and other graphs keep the rest. Across your 3 processes, one graph can have up to 12 reads on the database at once.' },
    'database.readsPerProcess': { value: 8, why: 'Each process keeps 10 database connections for versioned graphs; 8 reads at once leave 2 for writes and other work. Across your 3 processes, that is up to 24 reads at once.' },
}

const EXAMPLES: Record<string, string> = {
    'updates.readPressureRatio': 'While reads on a node are waiting, a write that takes 500 ms is followed by a 1,250 ms pause: reads get about 71% of the node\'s time until they catch up.',
    'builds.method': 'Auto: a build copies the current copy when its node has 250% of the graph\'s size free, else builds it from the database on the node with the most room.',
    'builds.copyRoomPct': 'A copy of your largest graph, 9.4 GB, needs 23.5 GB free on its node, under the node\'s start mark.',
    'builds.perWorker': 'Each worker runs up to 4 builds at once, among the 4 graphs it updates at once; more builds wait their turn.',
    'residency.class': 'A Standard graph nobody reads for 14 days is unloaded; its next read comes from the database and loads it again.',
    'residency.autoUnload': 'Standard graphs unread for 14 days and Coldline graphs unread for 1 hour are unloaded, and a node past 80% of its memory unloads graphs until it is at 70%.',
    'residency.standardIdleSecs': 'A Standard graph nobody reads for 14 days is unloaded; its next read comes from the database and loads it again.',
    'residency.unloadStartPct': 'Node 1 (12 GB) starts unloading graphs at 9.6 GB used; a load or a copy must fit under that.',
    'database.readsPerProcess': 'Each process runs up to 8 reads from the database at once, of the 10 connections it keeps.',
    'imports.replaceGuard': 'A replace of 5,000 items or more that would delete 50% of them and make 50% as many again is stopped before it deletes anything.',
    'imports.guardMinLive': 'The replace guard checks replaces of 5,000 items or more; smaller ones go straight through.',
}

const POSTURES: Record<string, string> = {
    updates: 'Each write to the graph store aims at 500 ms and stops at 10 seconds; after it, the worker pauses 25% of the write\'s time, or 250% while reads wait. A previous copy is kept 15 minutes after a switch or a move.',
    builds: 'With New-version builds on, publishes of more than 200,000 changes to graphs set to switch when ready are built in a second copy (copied when there\'s room, else from the database), 4 at a time per worker, and so are their rebuilds and moves.',
    residency: 'With Graph residency on, graphs are Standard unless set otherwise. Standard graphs unload after 14 days unread and Coldline after 1 hour; a node unloads graphs from 80% of its memory down to 70%.',
    imports: 'Imports match rows by entity id, then URN and the rest the platform knows items by. The replace guard is on: a replace of 5,000 items or more that would delete 50% and make 50% as many again is stopped. An import holds on any refused row.',
}

function served(s: Setting): Setting {
    const ftp = FOR_THIS_PLATFORM[s.key]
    const example = EXAMPLES[s.key]
    if (!ftp && !example) return s
    return {
        ...s,
        guidance: {
            ...s.guidance,
            example: example ?? s.guidance.example,
            recommended: { ...s.guidance.recommended, forThisPlatform: ftp ?? s.guidance.recommended.forThisPlatform },
        },
    }
}

export const SCHEMA: SettingsSchema = {
    ...CATALOGUE,
    categories: CATALOGUE.categories.map((c) => ({ ...c, posture: POSTURES[c.id] ?? c.posture })),
    settings: CATALOGUE.settings.map(served),
}

export const SETTINGS_BY_KEY: Record<string, Setting> = Object.fromEntries(SCHEMA.settings.map((s) => [s.key, s]))
