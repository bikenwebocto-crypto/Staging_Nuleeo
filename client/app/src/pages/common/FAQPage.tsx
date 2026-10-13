import { useLocation } from "wouter";
import { ArrowLeft } from "lucide-react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@ui/components/ui/accordion";
import { useHideMobileHeader } from "@/components/common/AppLayout";

export default function FAQPage() {
  useHideMobileHeader();
  const [, setLocation] = useLocation();
  const faqs = [
    {
      question: "How do I add a property?",
      answer:
        "Navigate to the Properties page and click the '+' button in the top right corner. Fill in the property details and save.",
    },
    {
      question: "Which plan should I choose?",
      answer:
        "Olio has four tiers — Starter, Growth, Pro, and Business. Each unlocks more units, advanced analytics, and tenant-management features. Visit the pricing modal from your Profile to compare what's included at each tier.",
    },
    {
      question: "How do I upgrade my plan?",
      answer:
        "Open your Profile drawer and tap UPGRADE. Olio uses Stripe Checkout, so you'll be back here as soon as payment confirms.",
    },
    {
      question: "Is my data secure?",
      answer:
        "Yes. Olio is built on Firebase with industry-standard encryption in transit and at rest. Payments are processed by Stripe — we never see your card details.",
    },
    {
      question: "How do I invite a tenant?",
      answer:
        "On the Tenants page, click 'Add Tenant'. You can then assign them to a property and send an invitation email.",
    },
    {
      question: "What payment methods are supported?",
      answer:
        "We support major credit and debit cards via Stripe, plus direct bank transfers (IBAN) for rent collection.",
    },
  ];

  return (
    <>
      {/* Mobile Header */}
      <div className="md:hidden bg-card pt-6 px-5 flex items-center justify-between mb-8 sticky top-0 z-10 shadow-sm pb-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            aria-label="Back"
            onClick={() => {
              if (window.history.length > 1) window.history.back();
              else setLocation("/owner");
            }}
            className="w-10 h-10 bg-secondary rounded-full flex items-center justify-center hover:bg-secondary transition"
          >
            <ArrowLeft size={20} className="text-foreground" />
          </button>
          <h1 className="text-xl font-bold text-foreground">Knowledge Base</h1>
        </div>
      </div>

      <div className="max-w-md mx-auto md:max-w-none md:mx-0 px-5 md:px-8 pb-10">
        <div className="bg-card p-6 rounded-3xl shadow-sm border border-border mb-6">
          <h2 className="font-bold text-lg mb-4">Frequently Asked Questions</h2>
          <Accordion type="single" collapsible className="w-full">
            {faqs.map((faq, index) => (
              <AccordionItem key={index} value={`item-${index}`} className="border-b-gray-100">
                <AccordionTrigger className="text-left font-medium text-foreground hover:no-underline hover:text-primary transition-colors py-4">
                  {faq.question}
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground leading-relaxed">
                  {faq.answer}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>

        <div className="bg-blue-500/10 p-6 rounded-3xl border border-blue-500/20 text-center">
          <h3 className="font-bold text-foreground mb-2">Still have questions?</h3>
          <p className="text-sm text-muted-foreground mb-4">
            Our support team is always ready to help you.
          </p>
          <a
            href="mailto:support@oliowallet.com"
            className="inline-block bg-card text-blue-600 dark:text-blue-400 font-bold py-2.5 px-6 rounded-xl shadow-sm border border-blue-500/20 hover:bg-blue-500/10 transition text-sm"
          >
            Contact Support
          </a>
        </div>
      </div>
    </>
  );
}
