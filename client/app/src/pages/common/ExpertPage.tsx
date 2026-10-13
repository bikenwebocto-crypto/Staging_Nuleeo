import { useState } from "react";
import { CheckCircle2, Send } from "lucide-react";
import { Link } from "wouter";
import { apiRequest } from "@ui/lib/queryClient";
import type { PortfolioSize } from "@shared/firestore-schema";
import { PAGE_CONTAINER_CLASSNAME } from "@/components/common/AppLayout";
import { PageHeader } from "@ui/components/common/PageHeader";

const PORTFOLIO_OPTIONS: { value: PortfolioSize; label: string }[] = [
  { value: "1-2", label: "1-2 Properties" },
  { value: "3-5", label: "3-5 Properties" },
  { value: "5-10", label: "5-10 Properties" },
  { value: "10+", label: "10+ Properties" },
];

const SERVICE_OPTIONS = [
  "Investment advice",
  "Asset management",
  "Legal assistance",
  "Tax planning",
  "Market analysis",
  "Property valuation",
];

export default function ExpertPage() {
  const [submitted, setSubmitted] = useState(false);
  const [message, setMessage] = useState("");
  const [portfolioSize, setPortfolioSize] = useState<PortfolioSize>(PORTFOLIO_OPTIONS[0].value);
  const [services, setServices] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleService(name: string) {
    setServices((prev) => (prev.includes(name) ? prev.filter((s) => s !== name) : [...prev, name]));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!message.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiRequest("POST", "/api/expert/apply", {
        message: message.trim(),
        portfolioSize,
        services,
      });
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not submit application");
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
        <div className="w-20 h-20 bg-success/15 text-success rounded-full flex items-center justify-center mb-6">
          <CheckCircle2 size={40} />
        </div>
        <h1 className="text-2xl font-bold text-foreground mb-2">Application Received</h1>
        <p className="text-muted-foreground mb-8 max-w-md">
          Thank you for applying. One of our expert account managers will review your profile and
          contact you within 24 hours.
        </p>
        <Link href="/owner">
          <button className="bg-primary text-primary-foreground font-bold py-3 px-8 rounded-xl shadow-lg shadow-primary/30">
            Back to Home
          </button>
        </Link>
      </div>
    );
  }

  return (
    <div className={`${PAGE_CONTAINER_CLASSNAME} space-y-6 max-w-3xl`}>
      <PageHeader title="Get an Expert" subtitle="Connect with an account manager" />
      <div className="bg-info/10 border border-info/20 p-4 rounded-xl text-info text-sm">
        <strong>Why get an Account Manager?</strong>
        <ul className="list-disc pl-4 mt-2 space-y-1 text-info/80">
          <li>Comprehensive asset management</li>
          <li>Expert market & legal guidance</li>
          <li>Strategic portfolio valuation</li>
        </ul>
      </div>

      <form className="space-y-4" onSubmit={handleSubmit}>
        <div className="space-y-1.5">
          <label className="text-sm font-semibold text-foreground ml-1">
            Let us know what you're looking for
          </label>
          <textarea
            rows={4}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="e.g. I want to maximize rental yield..."
            className="w-full bg-card border border-border rounded-xl px-4 py-3 text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-sm font-semibold text-foreground ml-1">
            Current Portfolio Size
          </label>
          <select
            value={portfolioSize}
            onChange={(e) => setPortfolioSize(e.target.value as PortfolioSize)}
            className="w-full bg-card border border-border rounded-xl px-4 py-3.5 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition appearance-none"
          >
            {PORTFOLIO_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <label className="text-sm font-semibold text-foreground ml-1">Services Needed</label>
          <div className="space-y-2">
            {SERVICE_OPTIONS.map((service) => (
              <label
                key={service}
                className="flex items-center gap-3 bg-card p-3 rounded-xl border border-border cursor-pointer hover:border-primary/50 transition"
              >
                <input
                  type="checkbox"
                  checked={services.includes(service)}
                  onChange={() => toggleService(service)}
                  className="w-5 h-5 text-primary rounded focus:ring-primary/20"
                />
                <span className="text-sm text-foreground font-medium">{service}</span>
              </label>
            ))}
          </div>
        </div>

        {error && (
          <div className="bg-destructive/10 text-destructive text-sm rounded-xl px-4 py-3">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting || !message.trim()}
          className="w-full bg-primary text-primary-foreground font-bold text-lg py-4 rounded-2xl shadow-lg shadow-primary/30 active:scale-[0.98] transition hover:bg-primary/90 mt-4 flex items-center justify-center gap-2 disabled:opacity-50"
        >
          <Send size={20} /> {submitting ? "Submitting..." : "Submit"}
        </button>
      </form>
    </div>
  );
}
