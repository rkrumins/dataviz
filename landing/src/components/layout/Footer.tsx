import { Github, MessageCircle } from 'lucide-react'

const PRODUCT_LINKS = [
  { label: 'Features', href: '#features' },
  { label: 'Architecture', href: '#architecture' },
  { label: 'Integrations', href: '#integrations' },
  { label: 'Compare', href: '#comparison' },
]

const RESOURCE_LINKS = [
  { label: 'FAQ', href: '#faq' },
  { label: 'How It Works', href: '#how-it-works' },
  { label: 'AI Assistant', href: '#ai-assistant' },
  { label: 'Request Demo', href: '#contact' },
]

const COMPANY_LINKS = [
  { label: 'Open Source', href: '#community' },
  { label: 'Contact', href: '#contact' },
]

const SOCIAL_LINKS = [
  { label: 'GitHub', href: 'https://github.com', icon: Github },
  { label: 'Discord', href: 'https://discord.gg', icon: MessageCircle },
]

export function Footer() {
  return (
    <footer className="border-t border-[var(--nx-border-subtle)] bg-canvas-elevated">
      <div className="max-w-7xl mx-auto px-6 lg:px-8 py-16">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-10">
          {/* Brand */}
          <div className="col-span-2 md:col-span-1">
            <a href="#hero" className="flex items-center gap-2.5 mb-4">
              <img src="/nexus-icon.svg" alt="Nexus Lineage" className="w-7 h-7" />
              <span className="font-display font-semibold text-ink">
                Nexus<span className="text-accent-lineage">Lineage</span>
              </span>
            </a>
            <p className="text-sm text-ink-secondary leading-relaxed">
              Data lineage visualization for the modern data stack.
            </p>
            <div className="flex gap-3 mt-4">
              {SOCIAL_LINKS.map(({ label, href, icon: Icon }) => (
                <a
                  key={label}
                  href={href}
                  className="p-2 rounded-lg text-ink-muted hover:text-ink hover:bg-canvas transition-colors"
                  aria-label={label}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Icon size={18} />
                </a>
              ))}
            </div>
          </div>

          {/* Product */}
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-widest text-ink-muted mb-4">Product</h4>
            <ul className="space-y-2.5">
              {PRODUCT_LINKS.map(({ label, href }) => (
                <li key={label}>
                  <a href={href} className="text-sm text-ink-secondary hover:text-ink transition-colors">
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          {/* Resources */}
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-widest text-ink-muted mb-4">Resources</h4>
            <ul className="space-y-2.5">
              {RESOURCE_LINKS.map(({ label, href }) => (
                <li key={label}>
                  <a href={href} className="text-sm text-ink-secondary hover:text-ink transition-colors">
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          {/* Company */}
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-widest text-ink-muted mb-4">Company</h4>
            <ul className="space-y-2.5">
              {COMPANY_LINKS.map(({ label, href }) => (
                <li key={label}>
                  <a href={href} className="text-sm text-ink-secondary hover:text-ink transition-colors">
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Copyright */}
        <div className="mt-12 pt-8 border-t border-[var(--nx-border-subtle)] text-center">
          <p className="text-xs text-ink-muted">
            &copy; {new Date().getFullYear()} Nexus Lineage Contributors. Open source under the Apache 2.0 license.
          </p>
        </div>
      </div>
    </footer>
  )
}
