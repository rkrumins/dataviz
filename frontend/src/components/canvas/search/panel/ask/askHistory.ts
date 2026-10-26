/** Questions asked before, newest first — ↑ in the Ask bar brings them back. */
export const ASK_HISTORY_KEY = 'synodic.advancedSearch.askHistory.v1'
const HISTORY_MAX = 20

export function readHistory(): string[] {
    try {
        const saved = JSON.parse(localStorage.getItem(ASK_HISTORY_KEY) ?? '[]')
        return Array.isArray(saved) ? saved.filter((q): q is string => typeof q === 'string') : []
    } catch {
        return []
    }
}

export function remember(question: string) {
    const next = [question, ...readHistory().filter((q) => q !== question)].slice(0, HISTORY_MAX)
    try { localStorage.setItem(ASK_HISTORY_KEY, JSON.stringify(next)) } catch { /* not remembered */ }
}
