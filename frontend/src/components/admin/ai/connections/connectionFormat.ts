/** Connections and their test results, in words. */
import type { Capabilities } from '@/services/aiAdminService'

export const CHECK_LABELS: Record<string, string> = {
    answer: 'Answers a question',
    tools: 'Calls a tool',
    embeddings: 'Makes embeddings',
}

export function hostOf(url: string): string {
    try {
        return new URL(url).host
    } catch {
        return url
    }
}

/** What a connection was found able to do, as badges. */
export function capabilityBadges(c: Capabilities | undefined): { label: string; tone: 'success' | 'info' | 'warning' | 'accent' | 'neutral' }[] {
    if (!c || Object.keys(c).length === 0) return [{ label: 'Not tested yet', tone: 'neutral' }]
    const out: ReturnType<typeof capabilityBadges> = []
    if (c.nativeTools) out.push({ label: 'Tools native', tone: 'success' })
    else if (c.tools) out.push({ label: 'JSON protocol', tone: 'info' })
    else out.push({ label: 'No tools', tone: 'warning' })
    if (c.embeddings) out.push({ label: 'Embeddings', tone: 'accent' })
    return out
}

/** A check's detail: a sentence as it came, or what came back as "key: value". */
export function detailText(detail: unknown): string {
    if (detail == null) return ''
    if (typeof detail === 'string') return detail
    if (typeof detail === 'object') {
        return Object.entries(detail as Record<string, unknown>)
            .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
            .join(' · ')
    }
    return String(detail)
}

/** How the assistant can call tools on a connection. */
export function toolsText(c: Capabilities | undefined): string {
    if (!c?.tools) return 'No tool calling — the assistant cannot look things up through it'
    return c.nativeTools ? 'Native tool calling' : 'Tools through the JSON protocol'
}
