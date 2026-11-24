/**
 * What people do, named once — the label, palette slot and icon of each kind.
 *
 * Mirrors `KINDS` in `backend/app/db/repositories/people_activity_repo.py`, in
 * the same order, which is the order every chart stacks them. Six kinds take the
 * six validated slots; "Other" is the residual and takes the neutral mark, as the
 * palette rule requires — a seventh hue would collide with one already drawn.
 */
import {
    Compass, Hammer, LogIn, MoreHorizontal, MousePointerClick, Route, Search, Workflow,
    type LucideIcon,
} from 'lucide-react'

import type { ActivityKind, FeedKind } from '@/services/peopleActivityService'
import { ACTIVITY_KINDS } from '@/services/peopleActivityService'

export interface KindMeta {
    label: string
    /** A short verb phrase for a person's row: "mostly browsing". */
    gerund: string
    /** Slot into the categorical palette; `undefined` is the neutral residual. */
    slot: number | undefined
    icon: LucideIcon
}

export const KIND_META: Record<FeedKind, KindMeta> = {
    signin: { label: 'Signed in', gerund: 'signing in', slot: 0, icon: LogIn },
    browse: { label: 'Opened views', gerund: 'browsing views', slot: 1, icon: MousePointerClick },
    trace: { label: 'Traced lineage', gerund: 'tracing lineage', slot: 2, icon: Route },
    search: { label: 'Searched', gerund: 'searching', slot: 3, icon: Search },
    build: { label: 'Built & edited', gerund: 'building', slot: 4, icon: Hammer },
    operate: { label: 'Ran data operations', gerund: 'operating data', slot: 5, icon: Workflow },
    other: { label: 'Other', gerund: 'other things', slot: undefined, icon: MoreHorizontal },
    section: { label: 'Moved around the app', gerund: 'moving around', slot: undefined, icon: Compass },
}

export const kindLabel = (kind: string): string =>
    KIND_META[kind as FeedKind]?.label ?? kind

export const kindSlot = (kind: string): number | undefined =>
    KIND_META[kind as FeedKind]?.slot

/** The kinds a lens can show: a workspace admin is never shown sign-ins. */
export function kindsFor(lens: 'full' | 'workspace'): readonly ActivityKind[] {
    return lens === 'full' ? ACTIVITY_KINDS : ACTIVITY_KINDS.filter((k) => k !== 'signin')
}

/** The sections `app.section` names. Mirrors `APP_SECTIONS` on the server and
 *  `tabForPath` here. */
export const APP_SECTION_LABELS: Record<string, string> = {
    dashboard: 'Dashboard',
    explore: 'Explorer',
    templates: 'Templates',
    ingestion: 'Ingestion',
    reviews: 'Reviews',
    playground: 'Playground',
    workspaces: 'Workspaces',
    schema: 'Semantic layer',
    analytics: 'Analytics',
    admin: 'Administration',
}

export const sectionLabel = (key: string): string => APP_SECTION_LABELS[key] ?? key

/** Minutes after UTC midnight → "09:40". */
export function minuteLabel(minute: number | null): string {
    if (minute == null) return '—'
    const h = Math.floor(minute / 60)
    const m = minute % 60
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** "14:05" in UTC — the clock a UTC day is told on. */
export function utcClock(iso: string): string {
    const d = new Date(iso)
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}
