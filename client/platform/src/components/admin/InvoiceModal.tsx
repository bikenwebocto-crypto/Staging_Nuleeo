import { Printer } from "lucide-react";
import { ResponsiveDrawer } from "@ui/components/common/ResponsiveDrawer";
import { Logo } from "@ui/components/Logo";
import { formatCurrency, formatDate } from "@ui/lib/format";

interface InvoiceModalProps {
  isOpen: boolean;
  onClose: () => void;
  transaction: any;
}

export function InvoiceModal({ isOpen, onClose, transaction }: InvoiceModalProps) {
  if (!transaction) return null;

  // Print uses the browser's native dialog (lets users "save as PDF" too,
  // which covers the download intent until a server-side PDF export ships).
  const footerContent = (
    <div className="flex items-center justify-end gap-2">
      <button
        type="button"
        onClick={() => window.print()}
        aria-label="Print invoice"
        className="p-2 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-lg transition-colors"
        title="Print or save as PDF"
      >
        <Printer size={18} />
      </button>
    </div>
  );

  return (
    <ResponsiveDrawer
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Invoice ${transaction.id}`}
      footer={footerContent}
      desktopMaxWidth="max-w-[800px]"
    >
      {/* A4 Paper */}
      <div className="bg-card shadow-sm w-full max-w-[210mm] mx-auto p-6 md:p-12 text-sm text-foreground rounded-lg border border-border">
        <div className="flex justify-between items-start mb-12">
          <div>
            <Logo variant="wordmark" color="dark" className="h-8 w-auto mb-2" />
            <p className="text-muted-foreground">Property Management</p>
          </div>
          <div className="text-right">
            <h2 className="text-xl font-medium text-foreground mb-2">INVOICE</h2>
            <div className="text-muted-foreground">#{transaction.id}</div>
            <div className="text-muted-foreground">
              Date: {formatDate(transaction.date || new Date().toISOString())}
            </div>
          </div>
        </div>

        <div className="flex justify-between items-start mb-12">
          <div>
            <div className="font-semibold text-foreground mb-2">Billed To:</div>
            <div className="text-foreground font-medium">{transaction.user}</div>
            <div className="text-muted-foreground">{transaction.userRole}</div>
            {transaction.property !== "-" && (
              <div className="text-muted-foreground mt-1">Property: {transaction.property}</div>
            )}
          </div>
          <div className="text-right">
            <div className="font-semibold text-foreground mb-2">From:</div>
            <div className="text-foreground font-medium">Olio Platform Ltd.</div>
            <div className="text-muted-foreground">123 Tech Hub Drive</div>
            <div className="text-muted-foreground">Limassol, 4001, Cyprus</div>
          </div>
        </div>

        <table className="w-full mb-8">
          <thead>
            <tr className="border-b-2 border-gray-900">
              <th className="py-3 text-left font-semibold text-foreground">Description</th>
              <th className="py-3 text-right font-semibold text-foreground w-32">Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-border">
              <td className="py-4">
                <div className="font-medium text-foreground">{transaction.type}</div>
                <div className="text-muted-foreground mt-1 text-xs">
                  {transaction.via
                    ? `Paid via ${transaction.via}`
                    : "Platform transaction processing"}
                </div>
              </td>
              <td className="py-4 text-right font-medium">
                {formatCurrency(Math.abs(transaction.amount))}
              </td>
            </tr>
          </tbody>
        </table>

        <div className="flex justify-end mb-12">
          <div className="w-64">
            <div className="flex justify-between py-2 border-b border-border">
              <span className="text-muted-foreground">Subtotal</span>
              <span className="font-medium">{formatCurrency(Math.abs(transaction.amount))}</span>
            </div>
            <div className="flex justify-between py-2 border-b border-border">
              <span className="text-muted-foreground">Tax (0%)</span>
              <span className="font-medium">€0.00</span>
            </div>
            <div className="flex justify-between py-3 border-b-2 border-gray-900 mt-1">
              <span className="font-semibold text-foreground">Total</span>
              <span className="font-bold text-foreground text-lg">
                {formatCurrency(Math.abs(transaction.amount))}
              </span>
            </div>
            {/* Refunded payments: show the amount returned to the cardholder and
                the net that actually stuck, so the invoice doesn't overstate. */}
            {transaction.refund != null && transaction.refund > 0 && (
              <>
                <div className="flex justify-between py-2 text-destructive">
                  <span>Refunded</span>
                  <span className="font-medium">−{formatCurrency(transaction.refund)}</span>
                </div>
                <div className="flex justify-between py-2 border-t border-border">
                  <span className="font-semibold text-foreground">Net</span>
                  <span className="font-bold text-foreground">
                    {formatCurrency(Math.max(0, Math.abs(transaction.amount) - transaction.refund))}
                  </span>
                </div>
              </>
            )}
            {/* Rent payments: the gross goes to the owner minus the platform's
                Connect application fee — surface the cut on the invoice. */}
            {transaction.kind === "rent" && transaction.platformFee != null && (
              <div className="text-xs text-muted-foreground text-right mt-2">
                Includes {formatCurrency(transaction.platformFee)} Olio platform fee
              </div>
            )}
          </div>
        </div>

        <div className="mt-16 pt-8 border-t border-border text-center text-muted-foreground text-xs">
          <p>Thank you for using Olio Property Management.</p>
          <p className="mt-1">For any inquiries, please contact support@oliowallet.com</p>
        </div>
      </div>
    </ResponsiveDrawer>
  );
}
