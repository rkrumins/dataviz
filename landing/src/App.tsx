import { Navbar } from '@/components/layout/Navbar'
import { Footer } from '@/components/layout/Footer'
import { ScrollProgress } from '@/components/ui/ScrollProgress'
import { BackToTop } from '@/components/ui/BackToTop'
import { Hero } from '@/components/sections/Hero'
import { LogoBar } from '@/components/sections/LogoBar'
import { ValueProps } from '@/components/sections/ValueProps'
import { FeatureShowcase } from '@/components/sections/FeatureShowcase'
import { HowItWorks } from '@/components/sections/HowItWorks'
import { AIAssistant } from '@/components/sections/AIAssistant'
import { UniversalLineage } from '@/components/sections/UniversalLineage'
import { Architecture } from '@/components/sections/Architecture'
import { Comparison } from '@/components/sections/Comparison'
import { Testimonials } from '@/components/sections/Testimonials'
import { Integrations } from '@/components/sections/Integrations'
import { FAQ } from '@/components/sections/FAQ'
import { CallToAction } from '@/components/sections/CallToAction'

/*
 * Page flow (narrative arc):
 *
 *  1. Hero                — Problem + vision + product preview
 *  2. LogoBar             — Quick credibility
 *  3. ValueProps           — 3 outcomes (why this matters)
 *  4. FeatureShowcase  ALT — 6 features with interactive demos (how it works)
 *  5. HowItWorks           — 5-step getting started
 *  6. AIAssistant      ALT — Natural language exploration (key selling point)
 *  7. UniversalLineage     — Connect to any graph/catalog
 *  8. Architecture     ALT — Technical depth for evaluators
 *  9. Comparison           — vs competitors
 * 10. Testimonials     ALT — Social proof
 * 11. Integrations         — Ecosystem
 * 12. FAQ              ALT — Objection handling
 * 13. CallToAction         — Convert
 *
 * Background alternation: every other section after LogoBar gets `alt`
 * for consistent visual rhythm.
 */

function App() {
  return (
    <div className="min-h-screen bg-canvas text-ink">
      <ScrollProgress />
      <Navbar />
      <main id="main">
        <Hero />
        <LogoBar />
        <ValueProps />
        <FeatureShowcase />      {/* alt applied inside component */}
        <HowItWorks />
        <AIAssistant />
        <UniversalLineage />
        <Architecture />
        <Comparison />
        <Testimonials />
        <Integrations />
        <FAQ />
        <CallToAction />
      </main>
      <Footer />
      <BackToTop />
    </div>
  )
}

export default App
