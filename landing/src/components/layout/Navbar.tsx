import { useState, useEffect } from 'react'
import { Menu, Github } from 'lucide-react'
import { motion } from 'framer-motion'
import { ThemeToggle } from '@/components/ui/ThemeToggle'
import { Button } from '@/components/ui/Button'
import { MobileMenu } from './MobileMenu'
import { useScrollspy } from '@/hooks/useScrollspy'

const NAV_LINKS = [
  { label: 'Features', href: '#features' },
  { label: 'AI Assistant', href: '#ai-assistant' },
  { label: 'Architecture', href: '#architecture' },
  { label: 'Compare', href: '#comparison' },
  { label: 'FAQ', href: '#faq' },
]

const SECTION_IDS = ['hero', 'features', 'showcase', 'how-it-works', 'ai-assistant', 'universal-lineage', 'architecture', 'comparison', 'testimonials', 'integrations', 'faq', 'community']

export function Navbar() {
  const [scrolled, setScrolled] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const activeId = useScrollspy(SECTION_IDS)

  useEffect(() => {
    const handler = () => setScrolled(window.scrollY > 40)
    window.addEventListener('scroll', handler, { passive: true })
    return () => window.removeEventListener('scroll', handler)
  }, [])

  return (
    <>
      {/* Skip to main content */}
      <a
        href="#hero"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[60] focus:px-4 focus:py-2 focus:bg-accent-lineage focus:text-white focus:rounded-lg focus:text-sm focus:font-medium"
      >
        Skip to main content
      </a>

      <header
        className={`fixed top-0 left-0 right-0 z-40 transition-all duration-300 ${
          scrolled
            ? 'glass-panel border-b border-[var(--nx-border-subtle)] shadow-sm'
            : 'bg-transparent'
        }`}
        role="banner"
      >
        <div className="max-w-7xl mx-auto px-6 lg:px-8 h-16 flex items-center justify-between">
          {/* Logo */}
          <a href="#hero" className="flex items-center gap-2.5 group" aria-label="Nexus Lineage — home">
            <img src="/nexus-icon.svg" alt="" className="w-8 h-8" />
            <span className="font-display font-semibold text-lg tracking-tight text-ink">
              Nexus<span className="text-accent-lineage">Lineage</span>
            </span>
          </a>

          {/* Desktop nav */}
          <nav className="hidden lg:flex items-center gap-0.5" aria-label="Main navigation">
            {NAV_LINKS.map(({ label, href }) => {
              const isActive = activeId === href.slice(1)
              return (
                <a
                  key={href}
                  href={href}
                  className={`relative px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                    isActive ? 'text-accent-lineage' : 'text-ink-secondary hover:text-ink'
                  }`}
                >
                  {label}
                  {isActive && (
                    <motion.div
                      layoutId="nav-underline"
                      className="absolute -bottom-0.5 left-3 right-3 h-0.5 rounded-full bg-accent-lineage"
                      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                    />
                  )}
                </a>
              )
            })}
          </nav>

          {/* Right side */}
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Button
              variant="ghost"
              href="https://github.com"
              className="hidden sm:inline-flex text-xs px-3 py-2"
              icon={<Github size={16} />}
            >
              Star
            </Button>
            <Button href="#contact" className="hidden sm:inline-flex text-xs px-4 py-2">
              Request Demo
            </Button>
            <button
              className="lg:hidden p-2 text-ink-secondary hover:text-ink"
              onClick={() => setMenuOpen(true)}
              aria-label="Open menu"
            >
              <Menu size={20} />
            </button>
          </div>
        </div>
      </header>

      <MobileMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        links={NAV_LINKS}
        activeId={activeId}
      />
    </>
  )
}
