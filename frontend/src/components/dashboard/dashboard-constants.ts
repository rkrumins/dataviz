import {
    TrendingUp,
    Globe,
    Network,
    Star,
    GitBranch,
    Layers,
    BarChart3,
    Eye,
} from 'lucide-react'

// ───────────────────────────────────────────────────────────────────────────────
// Quick Suggestions (Hero Search)
// ───────────────────────────────────────────────────────────────────────────────
export const QUICK_SUGGESTIONS = [
    { icon: TrendingUp, label: 'Sales Pipeline', category: 'Model' },
    { icon: Globe, label: 'Customer 360', category: 'View' },
    { icon: Network, label: 'Data Lineage', category: 'Explore' },
    { icon: Star, label: 'Templates', category: 'Library' },
] as const

// ───────────────────────────────────────────────────────────────────────────────
// Category Colors (Search Results)
// ───────────────────────────────────────────────────────────────────────────────
export type SearchResultCategory = 'Workspace' | 'Data Source' | 'View' | 'Template' | 'Semantic Layer'

export const CATEGORY_COLORS: Record<SearchResultCategory, string> = {
    Workspace: 'bg-indigo-500/10 text-indigo-500 border-indigo-500/20',
    'Data Source': 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
    View: 'bg-violet-500/10 text-violet-500 border-violet-500/20',
    Template: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
    'Semantic Layer': 'bg-cyan-500/10 text-cyan-500 border-cyan-500/20',
}

// ───────────────────────────────────────────────────────────────────────────────
// Insight Card Themes
// ───────────────────────────────────────────────────────────────────────────────
export const CARD_THEMES = [
    { gradient: 'from-indigo-500/20 to-indigo-500/0', iconBg: 'bg-indigo-500/10 border-indigo-500/20 text-indigo-500', valueCls: 'text-indigo-600 dark:text-indigo-400', border: 'hover:border-indigo-500/40' },
    { gradient: 'from-rose-500/20 to-rose-500/0', iconBg: 'bg-rose-500/10 border-rose-500/20 text-rose-500', valueCls: 'text-rose-600 dark:text-rose-400', border: 'hover:border-rose-500/40' },
    { gradient: 'from-emerald-500/20 to-emerald-500/0', iconBg: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-500', valueCls: 'text-emerald-600 dark:text-emerald-400', border: 'hover:border-emerald-500/40' },
    { gradient: 'from-amber-500/20 to-amber-500/0', iconBg: 'bg-amber-500/10 border-amber-500/20 text-amber-500', valueCls: 'text-amber-600 dark:text-amber-400', border: 'hover:border-amber-500/40' },
]

// ───────────────────────────────────────────────────────────────────────────────
// Workspace Card Palettes
// ───────────────────────────────────────────────────────────────────────────────
export const WORKSPACE_PALETTES = [
    { icon: 'text-indigo-500 bg-indigo-500/10 border-indigo-500/20', accent: 'bg-indigo-500', label: 'text-indigo-500', ring: 'hover:border-indigo-500/40', shadow: 'hover:shadow-indigo-500/10' },
    { icon: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/20', accent: 'bg-emerald-500', label: 'text-emerald-500', ring: 'hover:border-emerald-500/40', shadow: 'hover:shadow-emerald-500/10' },
    { icon: 'text-violet-500 bg-violet-500/10 border-violet-500/20', accent: 'bg-violet-500', label: 'text-violet-500', ring: 'hover:border-violet-500/40', shadow: 'hover:shadow-violet-500/10' },
    { icon: 'text-rose-500 bg-rose-500/10 border-rose-500/20', accent: 'bg-rose-500', label: 'text-rose-500', ring: 'hover:border-rose-500/40', shadow: 'hover:shadow-rose-500/10' },
    { icon: 'text-amber-500 bg-amber-500/10 border-amber-500/20', accent: 'bg-amber-500', label: 'text-amber-500', ring: 'hover:border-amber-500/40', shadow: 'hover:shadow-amber-500/10' },
]

// ───────────────────────────────────────────────────────────────────────────────
// View Grid Layout Icons & Colors
// ───────────────────────────────────────────────────────────────────────────────
export const LAYOUT_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
    graph: Network, tree: GitBranch, hierarchy: Layers,
    'layered-lineage': BarChart3, reference: Eye,
}

export const LAYOUT_COLORS: Record<string, string> = {
    graph: 'text-indigo-500 bg-indigo-500/10 border-indigo-500/20',
    tree: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/20',
    hierarchy: 'text-violet-500 bg-violet-500/10 border-violet-500/20',
    'layered-lineage': 'text-rose-500 bg-rose-500/10 border-rose-500/20',
    reference: 'text-amber-500 bg-amber-500/10 border-amber-500/20',
}

// ───────────────────────────────────────────────────────────────────────────────
// Blueprint / Template Categories
// ───────────────────────────────────────────────────────────────────────────────
export const TEMPLATE_CATEGORIES = ['All', 'Data Lineage', 'Data Governance', 'Data Quality', 'Business Glossary', 'Impact Analysis']

// ───────────────────────────────────────────────────────────────────────────────
// Utility: Compact Number Formatting
// ───────────────────────────────────────────────────────────────────────────────
/** Format large numbers compactly: 263982 → "264k", 1234567 → "1.2M" */
export function compactNum(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
    if (n >= 10_000) return `${Math.round(n / 1_000)}k`
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
    return n.toString()
}
