import Navbar from "./sections/Navbar";
import HeroSection from "./sections/HeroSection";
import FeaturesSection from "./sections/FeaturesSection";
import HowItWorksSection from "./sections/HowItWorksSection";
import PricingSection from "./sections/PricingSection";
import CTASection from "./sections/CTASection";
import FooterSection from "./sections/FooterSection";
import { SkipToContent } from "@ui/components/common/SkipToContent";

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-background -mt-[36px]">
      <SkipToContent />
      <Navbar />
      <main id="main-content" tabIndex={-1} className="outline-none">
        <HeroSection />
        <FeaturesSection />
        <HowItWorksSection />
        <PricingSection />
        <CTASection />
      </main>
      <FooterSection />
    </div>
  );
}
