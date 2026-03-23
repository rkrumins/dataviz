import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type PersonaMode = 'business' | 'technical'
export type LODLevel = 'domain' | 'app' | 'asset'

interface PersonaState {
  mode: PersonaMode
  setMode: (mode: PersonaMode) => void
  toggleMode: () => void
  
  // Derived getters
  lodDefault: LODLevel
  labelStyle: 'friendly' | 'technical'
}

export const usePersonaStore = create<PersonaState>()(
  persist(
    (set, get) => ({
      mode: 'business',
      
      setMode: (mode) => set({ mode }),
      
      toggleMode: () => set((state) => ({ 
        mode: state.mode === 'business' ? 'technical' : 'business' 
      })),
      
      // Computed properties
      get lodDefault(): LODLevel {
        return get().mode === 'business' ? 'domain' : 'asset'
      },
      
      get labelStyle(): 'friendly' | 'technical' {
        return get().mode === 'business' ? 'friendly' : 'technical'
      },
    }),
    {
      name: 'nexus-persona',
      partialize: (state) => ({ mode: state.mode }),
    }
  )
)

// Selector hooks for performance
export const usePersonaMode = () => usePersonaStore((s) => s.mode)
export const useLODDefault = () => usePersonaStore((s) => s.lodDefault)

