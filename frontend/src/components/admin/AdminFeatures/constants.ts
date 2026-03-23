/**
 * Icon and color resolution for feature categories (API sends name/color; we map to components/classes).
 * Unknown icon or color falls back to default so new DB categories don't break the UI.
 */
import type { ComponentType } from 'react'
import {
  Pencil,
  LayoutTemplate,
  UserPlus,
  GitBranch,
  Palette,
  Shield,
  Plug,
  BarChart3,
  FlaskConical,
  Zap,
  Bell,
  Layers,
} from 'lucide-react'
import type { FeatureCategory } from '@/services/featuresService'

export const ICON_BY_NAME: Record<string, ComponentType<{ className?: string }>> = {
  Pencil,
  LayoutTemplate,
  UserPlus,
  GitBranch,
  Palette,
  Shield,
  Plug,
  BarChart3,
  FlaskConical,
  Zap,
  Bell,
  Layers,
}

export const DEFAULT_ICON = LayoutTemplate

export const COLOR_CLASSES: Record<string, { gradient: string; iconBg: string }> = {
  indigo: {
    gradient: 'from-indigo-500/20 to-indigo-500/0',
    iconBg: 'bg-indigo-500/10 border-indigo-500/20 text-indigo-600 dark:text-indigo-400',
  },
  violet: {
    gradient: 'from-violet-500/20 to-violet-500/0',
    iconBg: 'bg-violet-500/10 border-violet-500/20 text-violet-600 dark:text-violet-400',
  },
  emerald: {
    gradient: 'from-emerald-500/20 to-emerald-500/0',
    iconBg: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-400',
  },
  amber: {
    gradient: 'from-amber-500/20 to-amber-500/0',
    iconBg: 'bg-amber-500/10 border-amber-500/20 text-amber-600 dark:text-amber-400',
  },
  blue: {
    gradient: 'from-blue-500/20 to-blue-500/0',
    iconBg: 'bg-blue-500/10 border-blue-500/20 text-blue-600 dark:text-blue-400',
  },
  rose: {
    gradient: 'from-rose-500/20 to-rose-500/0',
    iconBg: 'bg-rose-500/10 border-rose-500/20 text-rose-600 dark:text-rose-400',
  },
  sky: {
    gradient: 'from-sky-500/20 to-sky-500/0',
    iconBg: 'bg-sky-500/10 border-sky-500/20 text-sky-600 dark:text-sky-400',
  },
  teal: {
    gradient: 'from-teal-500/20 to-teal-500/0',
    iconBg: 'bg-teal-500/10 border-teal-500/20 text-teal-600 dark:text-teal-400',
  },
  fuchsia: {
    gradient: 'from-fuchsia-500/20 to-fuchsia-500/0',
    iconBg: 'bg-fuchsia-500/10 border-fuchsia-500/20 text-fuchsia-600 dark:text-fuchsia-400',
  },
  orange: {
    gradient: 'from-orange-500/20 to-orange-500/0',
    iconBg: 'bg-orange-500/10 border-orange-500/20 text-orange-600 dark:text-orange-400',
  },
  slate: {
    gradient: 'from-slate-500/20 to-slate-500/0',
    iconBg: 'bg-slate-500/10 border-slate-500/20 text-slate-600 dark:text-slate-400',
  },
}

export const DEFAULT_CATEGORY_STYLE = {
  gradient: 'from-indigo-500/20 to-indigo-500/0',
  iconBg: 'bg-indigo-500/10 border-indigo-500/20 text-indigo-600 dark:text-indigo-400',
}

export function resolveCategoryStyle(meta: FeatureCategory | undefined, categoryId: string) {
  const Icon = meta ? (ICON_BY_NAME[meta.icon] ?? DEFAULT_ICON) : DEFAULT_ICON
  const style =
    meta && meta.color && COLOR_CLASSES[meta.color] ? COLOR_CLASSES[meta.color] : DEFAULT_CATEGORY_STYLE
  const label = meta?.label ?? categoryId
  return { Icon, style, label }
}

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}
