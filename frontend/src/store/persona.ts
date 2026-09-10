import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type PersonaMode = 'business' | 'technical'

interface PersonaState {
  mode: PersonaMode
  setMode: (mode: PersonaMode) => void
  toggleMode: () => void
}

export const usePersonaStore = create<PersonaState>()(
  persist(
    (set) => ({
      mode: 'business',
      
      setMode: (mode) => set({ mode }),
      
      toggleMode: () => set((state) => ({ 
        mode: state.mode === 'business' ? 'technical' : 'business' 
      })),
    }),
    {
      name: 'nexus-persona',
      partialize: (state) => ({ mode: state.mode }),
    }
  )
)

// Selector hooks for performance
export const usePersonaMode = () => usePersonaStore((s) => s.mode)
