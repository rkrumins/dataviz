/**
 * How far a draft save sent in parts has got (``saveGraphChangesInParts``): uploading its changes,
 * then the server writing them as one commit — what Review & Save shows while it waits. ``null``
 * while no such save is under way (a save of one request says only "Saving…").
 */
import { create } from 'zustand'
import type { SaveProgress } from '@/services/versioningApiService'

export const useSaveProgressStore = create<{ progress: SaveProgress | null; set: (p: SaveProgress | null) => void }>(
  (set) => ({ progress: null, set: (progress) => set({ progress }) }),
)
