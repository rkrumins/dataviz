/**
 * What the explainers draw from: the settings, the values in force and with the staged changes,
 * the platform's live facts, and how to stage. A row's explainer reads it only while its guidance
 * is open, so staging a value redraws the open explainers, not every row.
 */
import { createContext } from 'react'
import type { Setting, SettingsFacts, SettingValue, Values } from '@/components/settings'

export interface VisualContextValue {
    settings: Record<string, Setting>
    current: Values
    next: Values
    facts: SettingsFacts
    stage: (key: string, value: SettingValue | null) => void
}

export const VisualContext = createContext<VisualContextValue | null>(null)
