import { motion } from "framer-motion";
import { ArrowRight } from "lucide-react";
import bg from "@/assets/images/bg-carousel-8.jpg";
import { appUrl } from "@/lib/appUrl";
import { usePlanLabels } from "@/lib/planLabelsPublic";

export default function CTASection() {
  const goToApp = () => window.location.assign(appUrl("/auth"));
  // "Free plan available" only holds when the basic tier is actually free —
  // admins can set a non-zero price via config/planLabels. Drive copy off the
  // live config so we don't silently lie if pricing changes.
  const planLabels = usePlanLabels();
  const basicIsFree = (planLabels.plans.basic?.yearlyAmount ?? 0) === 0;

  return (
    <section className="relative py-24 md:py-32 overflow-hidden">
      <img src={bg} alt="" className="absolute inset-0 w-full h-full object-cover" />
      <div className="absolute inset-0 bg-black/50" />

      <div className="relative z-10 max-w-4xl mx-auto px-6 text-center">
        <motion.h2
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-3xl md:text-5xl font-bold text-white leading-tight"
        >
          Ready to transform your property management?
        </motion.h2>

        <motion.p
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, delay: 0.1 }}
          className="text-white/80 text-lg mt-6 max-w-2xl mx-auto"
        >
          {basicIsFree
            ? "Sign up free and start tracking your portfolio in minutes."
            : "Sign up and start tracking your portfolio in minutes."}
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, delay: 0.2 }}
          className="flex flex-col sm:flex-row gap-3 justify-center mt-10"
        >
          <button
            onClick={goToApp}
            className="px-8 py-4 bg-white text-black font-semibold text-lg rounded-full hover:bg-white/90 active:scale-[0.98] transition-all shadow-lg flex items-center justify-center gap-2"
          >
            {basicIsFree ? "Get Started Free" : "Get Started"} <ArrowRight size={20} />
          </button>
        </motion.div>

        <motion.p
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ delay: 0.4 }}
          className="text-white/50 text-sm mt-6"
        >
          {basicIsFree ? "Free plan available · " : ""}No credit card required · Cancel anytime
        </motion.p>
      </div>
    </section>
  );
}
