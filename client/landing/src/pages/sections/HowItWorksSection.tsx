import { motion } from "framer-motion";

const steps = [
  {
    num: "01",
    title: "Sign Up",
    description: "Create your account in seconds with email or Google.",
  },
  {
    num: "02",
    title: "Add Properties",
    description: "Import your portfolio or add properties one by one.",
  },
  {
    num: "03",
    title: "Start Managing",
    description: "Track rent, view analytics, and grow your investments.",
  },
];

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.15 } },
};

const item = {
  hidden: { opacity: 0, y: 24 },
  show: { opacity: 1, y: 0, transition: { duration: 0.5 } },
};

export default function HowItWorksSection() {
  return (
    <section id="how-it-works" className="py-24 md:py-32 bg-secondary/50">
      <div className="max-w-7xl mx-auto px-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-center mb-16"
        >
          <h2 className="text-3xl md:text-5xl font-bold text-foreground tracking-tight">
            How it works
          </h2>
          <p className="text-muted-foreground text-lg mt-4">Get started in minutes</p>
        </motion.div>

        {/* Steps */}
        <motion.div
          variants={container}
          initial="hidden"
          whileInView="show"
          viewport={{ once: true }}
          className="grid grid-cols-1 md:grid-cols-3 gap-8 md:gap-12 relative"
        >
          {/* Connecting line (desktop) */}
          <div className="hidden md:block absolute top-12 left-[20%] right-[20%] h-px border-t-2 border-dashed border-border" />

          {steps.map((step) => (
            <motion.div key={step.num} variants={item} className="text-center relative">
              <div className="w-24 h-24 rounded-full bg-card border-2 border-border flex items-center justify-center mx-auto mb-6 relative z-10">
                <span className="text-3xl font-bold text-foreground">{step.num}</span>
              </div>
              <h3 className="text-xl font-semibold text-foreground mb-2">{step.title}</h3>
              <p className="text-muted-foreground text-sm max-w-xs mx-auto">{step.description}</p>
            </motion.div>
          ))}
        </motion.div>

        {/* Dashboard mockup — decorative illustration with placeholder figures;
            hidden from assistive tech so screen readers don't read fake data. */}
        <motion.div
          aria-hidden="true"
          initial={{ opacity: 0, y: 40 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.8, delay: 0.3 }}
          className="mt-20 max-w-4xl mx-auto hidden md:block"
        >
          <div className="bg-card rounded-3xl shadow-2xl border border-border overflow-hidden">
            {/* Title bar */}
            <div className="flex items-center gap-2 px-5 py-3 border-b border-border">
              <div className="w-3 h-3 rounded-full bg-red-400" />
              <div className="w-3 h-3 rounded-full bg-yellow-400" />
              <div className="w-3 h-3 rounded-full bg-green-400" />
              <span className="ml-3 text-xs text-muted-foreground font-mono">olio — dashboard</span>
            </div>
            {/* Mock content */}
            <div className="p-6 md:p-8">
              <div className="grid grid-cols-3 gap-4 mb-6">
                {[
                  { label: "Properties", value: "12" },
                  { label: "Monthly Rent", value: "\u20AC48.5k" },
                  { label: "Occupancy", value: "96%" },
                ].map((stat) => (
                  <div key={stat.label} className="bg-secondary/50 rounded-xl p-4 text-center">
                    <p className="text-2xl md:text-3xl font-bold text-foreground">{stat.value}</p>
                    <p className="text-xs text-muted-foreground mt-1">{stat.label}</p>
                  </div>
                ))}
              </div>
              {/* Chart placeholder */}
              <div className="bg-secondary/30 rounded-xl p-4">
                <div className="flex items-end gap-2 h-24 justify-center">
                  {[40, 65, 50, 80, 55, 90, 70, 85, 60, 95, 75, 88].map((h, i) => (
                    <div
                      key={i}
                      className="bg-foreground/20 rounded-t-sm flex-1 max-w-6 transition-all"
                      style={{ height: `${h}%` }}
                    />
                  ))}
                </div>
                <p className="text-xs text-muted-foreground text-center mt-3">
                  Monthly Revenue Trend
                </p>
              </div>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
