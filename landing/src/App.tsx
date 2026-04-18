import { Navbar } from '@/components/layout/Navbar'
import { Footer } from '@/components/layout/Footer'
import { ScrollProgress } from '@/components/ui/ScrollProgress'
import { BackToTop } from '@/components/ui/BackToTop'
import { Hero } from '@/components/sections/Hero'
import { LogoBar } from '@/components/sections/LogoBar'
import { ValueProps } from '@/components/sections/ValueProps'
import { FeatureShowcase } from '@/components/sections/FeatureShowcase'
import { HowItWorks } from '@/components/sections/HowItWorks'
import { Architecture } from '@/components/sections/Architecture'
import { UniversalLineage } from '@/components/sections/UniversalLineage'
import { Comparison } from '@/components/sections/Comparison'
import { Integrations } from '@/components/sections/Integrations'
import { Testimonials } from '@/components/sections/Testimonials'
import { AIAssistant } from '@/components/sections/AIAssistant'
import { FAQ } from '@/components/sections/FAQ'
import { CallToAction } from '@/components/sections/CallToAction'

function App() {
  return (
    <div className="min-h-screen bg-canvas text-ink">
      <ScrollProgress />
      <Navbar />
      <main id="main">
        <Hero />
        <LogoBar />
        <ValueProps />
        <FeatureShowcase />
        <HowItWorks />
        <UniversalLineage />
        <Architecture />
        <Comparison />
        <Integrations />
        <Testimonials />
        <AIAssistant />
        <FAQ />
        <CallToAction />
      </main>
      <Footer />
      <BackToTop />
    </div>
  )
}

export default App
