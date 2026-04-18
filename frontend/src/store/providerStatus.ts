import { useMemo } from 'react'
import { create } from 'zustand'
import { providerService, type ProviderStatusResponse } from '@/services/providerService'

export interface ProviderStatusEntry extends ProviderStatusResponse {}

interface ProviderStatusState {
  statuses: Record<string, ProviderStatusEntry>
  lastUpdatedAt: number | null
  refresh: () => Promise<void>
}

const POLL_INTERVAL_MS = 30_000

export const useProviderStatusStore = create<ProviderStatusState>((set) => ({
  statuses: {},
  lastUpdatedAt: null,

  refresh: async () => {
    try {
      const statuses = await providerService.listStatus()
      set({
        statuses: Object.fromEntries(statuses.map((status) => [status.id, status])),
        lastUpdatedAt: Date.now(),
      })
    } catch {
      // Keep the previous snapshot. Provider status should never blank the UI.
    }
  },
}))

export function useProviderStatus(providerId: string | null | undefined): ProviderStatusEntry | null {
  return useProviderStatusStore((state) => {
    if (!providerId) return null
    return state.statuses[providerId] ?? null
  })
}

export function useAllProviderStatuses(): ProviderStatusEntry[] {
  const statuses = useProviderStatusStore((state) => state.statuses)
  return useMemo(() => Object.values(statuses), [statuses])
}

let pollTimer: ReturnType<typeof setTimeout> | null = null
let authReady = false

function stopPolling() {
  if (pollTimer) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
}

function startPolling() {
  if (pollTimer || !authReady || typeof document === 'undefined' || document.hidden) return

  const poll = async () => {
    await useProviderStatusStore.getState().refresh()
    pollTimer = setTimeout(poll, POLL_INTERVAL_MS)
  }

  void poll()
}

/** Call once after auth resolves to enable polling. */
export function enableProviderStatusPolling() {
  authReady = true
  startPolling()
}

/** Call on logout / session expiry to stop polling. */
export function disableProviderStatusPolling() {
  authReady = false
  stopPolling()
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopPolling()
    } else {
      startPolling()
    }
  })
}
