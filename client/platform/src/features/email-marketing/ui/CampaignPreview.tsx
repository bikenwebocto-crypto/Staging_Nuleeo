import { Eye } from "lucide-react";
import { Logo } from "@ui/components/Logo";
import { renderPreview } from "../lib/mergeVars";

export interface CampaignPreviewProps {
  subject: string;
  body: string;
  audienceLabel: string;
  signature?: string;
  footerText?: string;
  cta?: { label: string; url: string } | null;
}

const PREVIEW_CTX = { firstName: "John", lastName: "Doe" };

export function CampaignPreview({
  subject,
  body,
  audienceLabel,
  signature,
  footerText,
  cta,
}: CampaignPreviewProps) {
  const renderedSubject = renderPreview(subject, PREVIEW_CTX);
  const renderedBody = renderPreview(body, PREVIEW_CTX);
  const ctaLabel = cta?.label?.trim() ? renderPreview(cta.label, PREVIEW_CTX) : "";
  const renderedSignature = signature?.trim() ? renderPreview(signature, PREVIEW_CTX) : "";
  const renderedFooter = footerText?.trim() ? renderPreview(footerText, PREVIEW_CTX) : "";

  return (
    <div className="bg-card rounded-xl border border-border shadow-sm overflow-hidden sticky top-8">
      <div className="p-3 border-b border-border flex items-center justify-between bg-muted/30">
        <span className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
          <Eye size={14} />
          Preview
        </span>
        <span className="text-[10px] text-muted-foreground bg-muted px-2 py-0.5 rounded-full border border-border max-w-[60%] truncate">
          {audienceLabel}
        </span>
      </div>

      <div className="p-5">
        <div className="border border-border rounded-lg overflow-hidden">
          <div className="bg-neutral-900 text-white px-4 py-3 flex justify-center">
            <Logo variant="wordmark" color="white" className="h-5 w-auto" />
          </div>
          <div className="p-4 space-y-3">
            <h4 className="text-sm font-bold text-foreground leading-snug">
              {renderedSubject || "No subject"}
            </h4>
            <div className="text-xs text-muted-foreground leading-relaxed space-y-1.5">
              {renderedBody.split("\n").map((line, i) => (
                <p key={i} className="min-h-[0.5em]">
                  {line}
                </p>
              ))}
            </div>

            {ctaLabel && (
              <div className="flex justify-center pt-1">
                <span className="inline-block bg-neutral-900 text-white text-xs font-semibold px-4 py-2 rounded-md">
                  {ctaLabel}
                </span>
              </div>
            )}

            {renderedSignature && (
              <div className="text-xs text-muted-foreground leading-relaxed whitespace-pre-line pt-1">
                {renderedSignature}
              </div>
            )}

            <div className="pt-3 border-t border-border space-y-1.5">
              {renderedFooter && (
                <p className="text-[10px] text-muted-foreground whitespace-pre-line">
                  {renderedFooter}
                </p>
              )}
              <p className="text-[10px] text-muted-foreground text-center">
                © {new Date().getFullYear()} Olio Wallet · Unsubscribe
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
