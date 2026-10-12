/**
 * The lineage direction colours as the reader chose them
 * (lib/lineageDirectionColors.ts) — for code that needs real colour values;
 * CSS reads the same pair from `--nx-lineage-in-rgb` / `--nx-lineage-out-rgb`.
 */
import { useEffect, useMemo } from 'react'
import { usePreferencesStore } from '@/store/preferences'
import {
  hexToChannels,
  resolveLineageDirectionColors,
  saturateHex,
  type LineageDirectionColors,
} from '@/lib/lineageDirectionColors'

export interface ResolvedLineageDirectionColors extends LineageDirectionColors {
  /** Each colour as `filter: saturate(.35)` would paint it — the Focus Lens's
   *  wires off the focused cone. */
  inMuted: string
  outMuted: string
}

export function useLineageDirectionColors(): ResolvedLineageDirectionColors {
  const stored = usePreferencesStore((s) => s.lineageDirectionColors)
  return useMemo(() => {
    const colors = resolveLineageDirectionColors(stored)
    return { ...colors, inMuted: saturateHex(colors.in, 0.35), outMuted: saturateHex(colors.out, 0.35) }
  }, [stored])
}

/** Writes the chosen pair over the stylesheet's defaults. Mounted once, by
 *  the app shell. */
export function useApplyLineageDirectionColors(): void {
  const colors = useLineageDirectionColors()
  useEffect(() => {
    const root = document.documentElement.style
    root.setProperty('--nx-lineage-in-rgb', hexToChannels(colors.in))
    root.setProperty('--nx-lineage-out-rgb', hexToChannels(colors.out))
  }, [colors.in, colors.out])
}
