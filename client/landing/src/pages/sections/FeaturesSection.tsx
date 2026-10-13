import { motion } from "framer-motion";
import { Building2, Wallet, Sparkles, Users, BarChart3, Shield } from "lucide-react";

const features = [
  {
    icon: Building2,
    title: "Portfolio Management",
    description: "Track all your properties, units, and tenants in one unified dashboard.",
  },
  {
    icon: Wallet,
    title: "Smart Rent Collection",
    description:
      "Automated rent tracking with multiple payment channels and instant notifications.",
  },
  {
    icon: Sparkles,
    title: "AI-Powered Insights",
    description: "Get intelligent recommendations to maximize your property investment returns.",
  },
  {
    icon: Users,
    title: "Tenant Portal",
    description: "Give tenants a seamless experience for payments, agreements, and communication.",
  },
  {
    icon: BarChart3,
    title: "Financial Analytics",
    description: "Real-time analytics with detailed breakdowns of income, expenses, and growth.",
  },
  {
    icon: Shield,
    title: "Secure & Private",
    description: "Bank-grade encryption with full privacy controls for all your data.",
  },
];

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.1 } },
};

const item = {
  hidden: { opacity: 0, y: 24 },
  show: { opacity: 1, y: 0, transition: { duration: 0.5 } },
};

export default function FeaturesSection() {
  return (
    <section id="features" className="py-24 md:py-32 bg-background">
      <div className="max-w-7xl mx-auto px-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-center mb-16"
        >
          <h2 className="text-3xl md:text-5xl font-bold text-foreground tracking-tight">
            Everything you need
          </h2>
          <p className="text-muted-foreground text-lg mt-4 max-w-2xl mx-auto">
            One platform to manage your entire real estate portfolio
          </p>
        </motion.div>

        <motion.div
          variants={container}
          initial="hidden"
          whileInView="show"
          viewport={{ once: true }}
          className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6"
        >
          {features.map((feature) => (
            <motion.div
              key={feature.title}
              variants={item}
              className="bg-card border border-border rounded-2xl p-6 hover:shadow-lg transition-shadow duration-300 group"
            >
              <div className="w-12 h-12 rounded-xl bg-secondary flex items-center justify-center mb-4 group-hover:bg-black group-hover:text-white dark:group-hover:bg-white dark:group-hover:text-black transition-colors duration-300">
                <feature.icon size={24} />
              </div>
              <h3 className="text-lg font-semibold text-foreground mb-2">{feature.title}</h3>
              <p className="text-muted-foreground text-sm leading-relaxed">{feature.description}</p>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
