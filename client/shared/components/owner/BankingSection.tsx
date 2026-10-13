// Single source of truth for the owner's banking-method management UI.
// Rendered by three surfaces:
//   - /banking          (full route — client/app/src/pages/owner/BankingPage.tsx)
//   - /payment-channels (full route — client/app/src/pages/common/PaymentChannelsPage.tsx)
//   - ProfileDrawer banking-settings subview
//
// All three surfaces are now thin wrappers around this component — chrome
// (mobile header, page padding, drawer wrapping) lives in the wrappers; all
// state and actions live here so behavior can't drift between them.
//
// Connect state is derived from the live user profile via useConnectStatus
// (6 states). Each state surfaces specific actions per the Stripe Connect
// onboarding docs: https://docs.stripe.com/connect/onboarding/quickstart

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Landmark,
  CreditCard,
  Trash2,
  Pencil,
  X,
  XCircle,
  ArrowRight,
  Loader2,
  Info,
  ExternalLink,
  RefreshCw,
} from "lucide-react";
import { useAuth } from "@ui/lib/useAuth";
import { apiRequest, parseApiError } from "@ui/lib/queryClient";
import { formatCurrency } from "@ui/lib/format";
import { ConnectStatusBadge } from "@ui/components/owner/ConnectStatusBadge";
import { useConnectStatus } from "@ui/lib/useConnectStatus";
import { requirementLabel } from "@ui/lib/connectRequirements";
import { useConfirm } from "@ui/components/common/ConfirmDialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@ui/components/ui/dialog";
import { useIsMobile } from "@ui/hooks/use-mobile";

type PlanKey = "basic" | "advance" | "pro" | "business";
// Falls back to the canonical four-tier display names. Live admin-edited
// names come from usePlanLabels() — Banking shows whichever plan the owner
// is on, so we keep a static fallback here and let the caller pass overrides
// later if needed.
const PLAN_LABEL: Record<PlanKey, string> = {
  basic: "Starter",
  advance: "Growth",
  pro: "Pro",
  business: "Business",
};

interface FeeTier {
  plan: PlanKey;
  tier: { percent?: number; minAmountCents?: number };
}

type FormMode = null | "iban";

// Active-portfolio scope, supplied by the app-side page (BankingSection lives
// in client/shared and can't import the app-only useActivePortfolio context,
// so scope arrives as plain data via props).
export interface BankingScope {
  /** The portfolio owner whose banking we're managing. */
  ownerId: string;
  /** The STABLE Portfolio doc id for `?portfolioId=` API params (preferred
   *  over the legacy `?ownerId=`). Null/omitted while it's still resolving —
   *  the legacy param keeps working server-side throughout Phase 2. */
  portfolioDocId?: string | null;
  /** True when viewing your OWN portfolio → full UI (IBAN + Stripe Connect). */
  isSelf: boolean;
  /** Whether the current user may edit this portfolio's banking
   *  (the realtime "finance.manageBanking" privilege; owner is always true). */
  canManageBanking: boolean;
}

export interface BankingSectionProps {
  /** Path prefix for Stripe's `return_url` / `refresh_url` callbacks.
   *  Defaults to the current pathname; pass a literal when this component
   *  renders inside a drawer that wouldn't preserve location naturally. */
  returnPath?: string;
  /** Active-portfolio scope. Omitted (or isSelf) → the owner's own full UI.
   *  A granted (non-self) portfolio shows an IBAN-only manager for an
   *  authorized contact — Stripe Connect onboarding is the owner's own legal
   *  flow and isn't exposed here. */
  scope?: BankingScope;
}

// Thin selector between the owner's own full banking UI and a granted
// portfolio's IBAN-only manager. Kept as a hook-free wrapper so neither child
// violates the rules of hooks when the active portfolio switches (self↔granted
// swaps the whole child component rather than changing one component's hooks).
export function BankingSection({ returnPath, scope }: BankingSectionProps = {}) {
  if (scope && !scope.isSelf) {
    return (
      <GrantedPortfolioBanking
        ownerId={scope.ownerId}
        portfolioDocId={scope.portfolioDocId}
        canManageBanking={scope.canManageBanking}
      />
    );
  }
  return <SelfBankingSection returnPath={returnPath} />;
}

function SelfBankingSection({ returnPath }: { returnPath?: string }) {
  const { profile, refreshProfile } = useAuth();
  const connect = useConnectStatus();
  const isMobile = useIsMobile();

  const hasBankTransfer = !!profile?.bankDetails?.iban;
  const stripeOnboarded = connect.kind === "active";
  const stripeOnFile = connect.kind !== "none";
  const activeMethodsCount = (hasBankTransfer ? 1 : 0) + (stripeOnboarded ? 1 : 0);
  const ibanTail = profile?.bankDetails?.iban?.slice(-4).toUpperCase() ?? "";

  const [formMode, setFormMode] = useState<FormMode>(null);
  // True when the IBAN form is open to edit existing details (vs. add new).
  // Only changes labels/title — both paths save through the same PUT.
  const [editingIban, setEditingIban] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Desktop opens the IBAN form in a modal; mobile keeps the inline form.
  const ibanInModal = !isMobile && formMode === "iban";

  // IBAN form state
  const [holder, setHolder] = useState("");
  const [iban, setIban] = useState("");
  const [swift, setSwift] = useState("");
  const [savingIban, setSavingIban] = useState(false);

  // Stripe action busy states
  const [connectingStripe, setConnectingStripe] = useState(false);
  const [refreshingStripe, setRefreshingStripe] = useState(false);
  const [openingDashboard, setOpeningDashboard] = useState(false);
  const { confirm, dialog: confirmDialog } = useConfirm();

  // Platform-fee disclosure — only meaningful when Stripe Connect is active,
  // since IBAN payouts bypass our commission entirely.
  const [feeTier, setFeeTier] = useState<FeeTier | null>(null);
  useEffect(() => {
    if (!stripeOnboarded) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiRequest("GET", "/api/owner/platform-fee-tier");
        const json = (await res.json()) as FeeTier;
        if (!cancelled) setFeeTier(json);
      } catch {
        // non-blocking
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [stripeOnboarded]);

  // Compute the URLs Stripe will redirect to. Falls back to current location
  // when no returnPath is given (allows drawer use-case where we redirect
  // back to wherever the user was).
  function getCallbackUrls() {
    const base = returnPath
      ? `${window.location.origin}${returnPath}`
      : `${window.location.origin}${window.location.pathname}`;
    return {
      returnUrl: `${base}?stripe=return`,
      refreshUrl: `${base}?stripe=refresh`,
    };
  }

  // Handle Stripe's two redirect URLs on mount:
  //   ?stripe=return  — user finished/exited the form; re-check state
  //   ?stripe=refresh — AccountLink expired; mint fresh + redirect
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tag = params.get("stripe");
    if (tag !== "return" && tag !== "refresh") return;

    (async () => {
      if (tag === "return") {
        setRefreshingStripe(true);
        try {
          await apiRequest("POST", "/api/owner/stripe-connect/refresh");
          await refreshProfile();
        } catch (err) {
          setSubmitError(parseApiError(err, "Failed to refresh status"));
        } finally {
          setRefreshingStripe(false);
          const url = new URL(window.location.href);
          url.searchParams.delete("stripe");
          window.history.replaceState({}, "", url.toString());
        }
      } else {
        try {
          const urls = getCallbackUrls();
          const res = await apiRequest("POST", "/api/owner/stripe-connect/refresh-link", urls);
          const data = (await res.json()) as { url: string };
          window.location.href = data.url;
        } catch (err) {
          setSubmitError(parseApiError(err, "Failed to resume Stripe onboarding"));
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshProfile]);

  function resetForm() {
    setFormMode(null);
    setEditingIban(false);
    setSubmitError(null);
    setHolder("");
    setIban("");
    setSwift("");
  }

  async function handleSaveIban(e: React.FormEvent) {
    e.preventDefault();
    setSavingIban(true);
    setSubmitError(null);
    try {
      await apiRequest("PUT", "/api/owner/bank-details", { holder, iban, swift });
      await refreshProfile();
      resetForm();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Failed to save bank details");
    } finally {
      setSavingIban(false);
    }
  }

  // Edit the existing IBAN in place — reuses the same form + PUT endpoint
  // as "Connect", just pre-filled with the current details.
  function handleEditIban() {
    setHolder(profile?.bankDetails?.holder ?? "");
    setIban(profile?.bankDetails?.iban ?? "");
    setSwift(profile?.bankDetails?.swift ?? "");
    setEditingIban(true);
    setFormMode("iban");
    setSubmitError(null);
  }

  async function handleRemoveIban() {
    const ok = await confirm({
      title: "Remove this bank account?",
      description:
        activeMethodsCount <= 1
          ? "This is your only payment method — tenants won't be able to pay you until you add a new one."
          : "Tenants paying you via IBAN will need to be reconfigured.",
      confirmLabel: "Remove",
      tone: "destructive",
    });
    if (!ok) return;
    try {
      await apiRequest("DELETE", "/api/owner/bank-details");
      await refreshProfile();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Failed to remove bank details");
    }
  }

  // Used for "Connect Stripe", "Continue setup", and "Resolve in Stripe".
  // The backend reuses the existing Connect account (or creates one) and
  // returns an AccountLink URL pre-filtered to the next step.
  async function handleStartOrContinueStripe() {
    setConnectingStripe(true);
    setSubmitError(null);
    try {
      const urls = getCallbackUrls();
      const res = await apiRequest("POST", "/api/owner/stripe-connect/account-link", urls);
      const data = (await res.json()) as { url: string };
      window.location.href = data.url;
    } catch (err) {
      setSubmitError(parseApiError(err, "Failed to start Stripe onboarding"));
      setConnectingStripe(false);
    }
  }

  async function handleRefreshStripe() {
    setRefreshingStripe(true);
    setSubmitError(null);
    try {
      await apiRequest("POST", "/api/owner/stripe-connect/refresh");
      await refreshProfile();
    } catch (err) {
      setSubmitError(parseApiError(err, "Failed to refresh status"));
    } finally {
      setRefreshingStripe(false);
    }
  }

  // "Manage on Stripe" — owners have full Stripe Dashboard (Standard)
  // accounts, so the backend returns dashboard.stripe.com (there is no
  // one-time Express login link); the owner signs in with their own Stripe
  // credentials to manage bank account, balance, payouts and details.
  async function handleOpenStripeDashboard() {
    setOpeningDashboard(true);
    setSubmitError(null);
    try {
      const res = await apiRequest("POST", "/api/owner/stripe-connect/login-link");
      const data = (await res.json()) as { url: string };
      window.location.href = data.url;
    } catch (err) {
      setSubmitError(parseApiError(err, "Failed to open Stripe dashboard"));
      setOpeningDashboard(false);
    }
  }

  async function handleDisconnectStripe() {
    if (activeMethodsCount <= 1 && stripeOnboarded) return;
    const ok = await confirm({
      title: "Disconnect your Stripe account?",
      description: "You won't accept card payments until you reconnect.",
      confirmLabel: "Disconnect",
      tone: "destructive",
    });
    if (!ok) return;
    try {
      await apiRequest("POST", "/api/owner/stripe-connect/disconnect");
      await refreshProfile();
    } catch (err) {
      setSubmitError(parseApiError(err, "Failed to disconnect Stripe"));
    }
  }

  return (
    <div className="space-y-6">
      {confirmDialog}
      {submitError && (
        <div className="bg-destructive/10 border border-destructive/20 text-destructive p-3 rounded-xl flex items-start gap-2 text-sm">
          <XCircle size={18} className="shrink-0 mt-0.5" />
          <span>{submitError}</span>
        </div>
      )}

      <div className="bg-card p-5 rounded-xl border border-border shadow-sm">
        <h3 className="text-sm font-semibold text-foreground mb-4">Active Payment Methods</h3>
        {!hasBankTransfer && !stripeOnFile ? (
          <div className="p-6 rounded-xl border border-dashed border-border text-center">
            <p className="text-sm text-muted-foreground">No active payment methods found.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {hasBankTransfer && (
              <div className="p-4 rounded-xl border border-border flex items-center justify-between group hover:bg-muted/30 transition">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 bg-info text-info-foreground rounded-full flex items-center justify-center">
                    <Landmark size={24} />
                  </div>
                  <div>
                    <h4 className="font-bold text-foreground">Bank Transfer</h4>
                    <p className="text-xs text-muted-foreground">IBAN ending in {ibanTail}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="px-2.5 py-1 bg-success/15 text-success text-[10px] font-bold rounded-lg">
                    Active
                  </span>
                  <button
                    type="button"
                    onClick={handleEditIban}
                    aria-label="Edit bank account"
                    className="p-1.5 rounded-lg transition-colors text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <Pencil size={16} />
                  </button>
                  <button
                    type="button"
                    onClick={handleRemoveIban}
                    aria-label="Remove bank account"
                    className="p-1.5 rounded-lg transition-colors text-destructive hover:bg-destructive/10"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            )}

            {stripeOnFile && (
              <div className="p-4 rounded-xl border border-border">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-4 min-w-0">
                    <div className="w-12 h-12 bg-[#635BFF] text-white rounded-full flex items-center justify-center shrink-0">
                      <CreditCard size={24} />
                    </div>
                    <div className="min-w-0">
                      <h4 className="font-bold text-foreground">Stripe Account</h4>
                      <p className="text-xs text-muted-foreground truncate">
                        {profile?.connectAccountId}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <ConnectStatusBadge status={connect} />
                    <button
                      type="button"
                      onClick={handleDisconnectStripe}
                      disabled={activeMethodsCount <= 1 && stripeOnboarded}
                      aria-label="Disconnect Stripe account"
                      className={`p-1.5 rounded-lg transition-colors ${
                        activeMethodsCount <= 1 && stripeOnboarded
                          ? "text-muted-foreground/30 cursor-not-allowed"
                          : "text-destructive hover:bg-destructive/10"
                      }`}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>

                <ConnectActions
                  status={connect}
                  onContinueOrResolve={handleStartOrContinueStripe}
                  onRefresh={handleRefreshStripe}
                  onOpenDashboard={handleOpenStripeDashboard}
                  busy={{
                    connecting: connectingStripe,
                    refreshing: refreshingStripe,
                    dashboard: openingDashboard,
                  }}
                />
              </div>
            )}

            {stripeOnboarded &&
              feeTier &&
              (() => {
                const pct = feeTier.tier.percent ?? 0;
                const minCents = feeTier.tier.minAmountCents ?? 0;
                const hasFee = pct > 0 || minCents > 0;
                return (
                  <div className="p-3.5 rounded-xl bg-muted/50 border border-border flex items-start gap-3">
                    <div className="w-8 h-8 bg-foreground/5 text-foreground rounded-full flex items-center justify-center shrink-0">
                      <Info size={15} />
                    </div>
                    <div className="text-xs leading-relaxed">
                      <p className="font-semibold text-foreground mb-0.5">
                        Platform fee on card payments
                      </p>
                      <p className="text-muted-foreground">
                        {hasFee ? (
                          <>
                            Olio takes <span className="font-medium text-foreground">{pct}%</span>
                            {minCents > 0 ? (
                              <>
                                {" "}
                                (minimum{" "}
                                <span className="font-medium text-foreground">
                                  {formatCurrency(minCents / 100)}
                                </span>
                                )
                              </>
                            ) : null}{" "}
                            of each card-paid rent payment. Your plan:{" "}
                            <span className="font-medium text-foreground">
                              {PLAN_LABEL[feeTier.plan]}
                            </span>
                            .
                          </>
                        ) : (
                          <>
                            No platform fee currently applies to your card payments. Your plan:{" "}
                            <span className="font-medium text-foreground">
                              {PLAN_LABEL[feeTier.plan]}
                            </span>
                            .
                          </>
                        )}
                      </p>
                    </div>
                  </div>
                );
              })()}
          </div>
        )}
      </div>

      <div className="bg-card p-5 rounded-xl border border-border shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-foreground">Add New Method</h3>
          {formMode && !ibanInModal && (
            <button
              type="button"
              onClick={resetForm}
              aria-label="Cancel"
              className="p-2 hover:bg-muted rounded-lg transition"
            >
              <X size={16} className="text-muted-foreground" />
            </button>
          )}
        </div>

        {(!formMode || ibanInModal) && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <button
              type="button"
              onClick={() => {
                setFormMode("iban");
                setSubmitError(null);
              }}
              disabled={hasBankTransfer}
              className="text-left p-5 rounded-2xl border border-border bg-background hover:bg-muted/40 hover:border-foreground/30 transition flex flex-col gap-3 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <div className="flex items-center justify-between">
                <div className="w-12 h-12 bg-info text-info-foreground rounded-xl flex items-center justify-center">
                  <Landmark size={24} />
                </div>
                {hasBankTransfer ? (
                  <span className="text-[10px] font-bold uppercase text-success bg-success/15 px-2 py-1 rounded-lg">
                    Connected
                  </span>
                ) : (
                  <ArrowRight size={18} className="text-muted-foreground" />
                )}
              </div>
              <div>
                <h4 className="font-bold text-foreground">Connect IBAN</h4>
                <p className="text-xs text-muted-foreground mt-1">
                  Accept rent via bank transfer. Tenants pay you directly using your IBAN.
                </p>
              </div>
            </button>

            <button
              type="button"
              onClick={() => {
                setSubmitError(null);
                void handleStartOrContinueStripe();
              }}
              disabled={stripeOnboarded || connectingStripe}
              className="text-left p-5 rounded-2xl border border-border bg-background hover:bg-muted/40 hover:border-foreground/30 transition flex flex-col gap-3 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <div className="flex items-center justify-between">
                <div className="w-12 h-12 bg-[#635BFF] text-white rounded-xl flex items-center justify-center">
                  <CreditCard size={24} />
                </div>
                {connectingStripe ? (
                  <Loader2 size={18} className="animate-spin text-muted-foreground" />
                ) : (
                  <ConnectStatusBadge status={connect} />
                )}
              </div>
              <div>
                <h4 className="font-bold text-foreground">Connect Stripe</h4>
                <p className="text-xs text-muted-foreground mt-1">
                  Accept card payments via Stripe Connect. Payouts land in your bank automatically.
                </p>
              </div>
            </button>
          </div>
        )}

        {formMode === "iban" && !ibanInModal && (
          <IbanForm
            holder={holder}
            setHolder={setHolder}
            iban={iban}
            setIban={setIban}
            swift={swift}
            setSwift={setSwift}
            saving={savingIban}
            editing={editingIban}
            onSubmit={handleSaveIban}
          />
        )}
      </div>

      <Dialog
        open={ibanInModal}
        onOpenChange={(open) => {
          if (!open) resetForm();
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editingIban ? "Edit Bank Details" : "Connect IBAN"}</DialogTitle>
          </DialogHeader>
          {submitError && (
            <div className="bg-destructive/10 border border-destructive/20 text-destructive p-3 rounded-xl flex items-start gap-2 text-sm">
              <XCircle size={18} className="shrink-0 mt-0.5" />
              <span>{submitError}</span>
            </div>
          )}
          <IbanForm
            holder={holder}
            setHolder={setHolder}
            iban={iban}
            setIban={setIban}
            swift={swift}
            setSwift={setSwift}
            saving={savingIban}
            editing={editingIban}
            onSubmit={handleSaveIban}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

// A granted portfolio's IBAN manager — shown when an authorized contact (e.g.
// a financial contact) has switched to a portfolio they don't own. Reads/writes
// the IBAN scoped to that portfolio (?portfolioId=<stable doc id>, preferred;
// legacy ?ownerId= while the doc id is still resolving); the server gates every
// call on the "finance.manageBanking" privilege. Stripe Connect is intentionally
// absent — onboarding is the owner's own legal flow, managed from their own
// profile.
function GrantedPortfolioBanking({
  ownerId,
  portfolioDocId,
  canManageBanking,
}: {
  ownerId: string;
  portfolioDocId?: string | null;
  canManageBanking: boolean;
}) {
  const queryClient = useQueryClient();
  const { confirm, dialog: confirmDialog } = useConfirm();

  const scopeParam = portfolioDocId
    ? `portfolioId=${encodeURIComponent(portfolioDocId)}`
    : `ownerId=${encodeURIComponent(ownerId)}`;
  const readUrl = `/api/owner/banking?${scopeParam}`;
  const writeUrl = `/api/owner/bank-details?${scopeParam}`;

  const { data, isLoading } = useQuery<{
    bankDetails: { holder: string; iban: string; swift: string } | null;
  }>({
    queryKey: [readUrl],
    enabled: canManageBanking,
  });
  const bankDetails = data?.bankDetails ?? null;
  const ibanTail = bankDetails?.iban?.slice(-4).toUpperCase() ?? "";

  const [formMode, setFormMode] = useState<FormMode>(null);
  const [editing, setEditing] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [holder, setHolder] = useState("");
  const [iban, setIban] = useState("");
  const [swift, setSwift] = useState("");
  const [saving, setSaving] = useState(false);

  function reset() {
    setFormMode(null);
    setEditing(false);
    setSubmitError(null);
    setHolder("");
    setIban("");
    setSwift("");
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSubmitError(null);
    try {
      await apiRequest("PUT", writeUrl, { holder, iban, swift });
      await queryClient.invalidateQueries({ queryKey: [readUrl] });
      reset();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Failed to save bank details");
    } finally {
      setSaving(false);
    }
  }

  function handleEdit() {
    setHolder(bankDetails?.holder ?? "");
    setIban(bankDetails?.iban ?? "");
    setSwift(bankDetails?.swift ?? "");
    setEditing(true);
    setFormMode("iban");
    setSubmitError(null);
  }

  async function handleRemove() {
    const ok = await confirm({
      title: "Remove this bank account?",
      description: "Tenants paying via IBAN will need to be reconfigured.",
      confirmLabel: "Remove",
      tone: "destructive",
    });
    if (!ok) return;
    try {
      await apiRequest("DELETE", writeUrl);
      await queryClient.invalidateQueries({ queryKey: [readUrl] });
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Failed to remove bank details");
    }
  }

  // Defense in depth: the page shouldn't route a contact here without the
  // privilege, and the server rejects it regardless — but never render an edit
  // surface we already know is forbidden.
  if (!canManageBanking) {
    return (
      <div className="bg-card p-5 rounded-xl border border-border shadow-sm flex items-start gap-2 text-sm text-muted-foreground">
        <Info size={16} className="shrink-0 mt-0.5" />
        You don't have permission to manage banking for this portfolio.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {confirmDialog}
      {submitError && (
        <div className="bg-destructive/10 border border-destructive/20 text-destructive p-3 rounded-xl flex items-start gap-2 text-sm">
          <XCircle size={18} className="shrink-0 mt-0.5" />
          <span>{submitError}</span>
        </div>
      )}

      <div className="bg-card p-5 rounded-xl border border-border shadow-sm">
        <h3 className="text-sm font-semibold text-foreground mb-1">Bank Transfer (IBAN)</h3>
        <p className="text-xs text-muted-foreground mb-4">
          You're managing rent-payout banking for a portfolio you've been granted access to. Card
          payments (Stripe) are set up by the portfolio owner.
        </p>

        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
            <Loader2 size={16} className="animate-spin" />
            Loading…
          </div>
        ) : bankDetails && formMode !== "iban" ? (
          <div className="p-4 rounded-xl border border-border flex items-center justify-between hover:bg-muted/30 transition">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 bg-info text-info-foreground rounded-full flex items-center justify-center">
                <Landmark size={24} />
              </div>
              <div>
                <h4 className="font-bold text-foreground">Bank Transfer</h4>
                <p className="text-xs text-muted-foreground">IBAN ending in {ibanTail}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleEdit}
                aria-label="Edit bank account"
                className="p-1.5 rounded-lg transition-colors text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <Pencil size={16} />
              </button>
              <button
                type="button"
                onClick={handleRemove}
                aria-label="Remove bank account"
                className="p-1.5 rounded-lg transition-colors text-destructive hover:bg-destructive/10"
              >
                <Trash2 size={16} />
              </button>
            </div>
          </div>
        ) : formMode !== "iban" ? (
          <button
            type="button"
            onClick={() => {
              setFormMode("iban");
              setEditing(false);
              setSubmitError(null);
            }}
            className="text-left p-5 rounded-2xl border border-border bg-background hover:bg-muted/40 hover:border-foreground/30 transition flex items-center gap-3 w-full"
          >
            <div className="w-12 h-12 bg-info text-info-foreground rounded-xl flex items-center justify-center shrink-0">
              <Landmark size={24} />
            </div>
            <div>
              <h4 className="font-bold text-foreground">Add IBAN</h4>
              <p className="text-xs text-muted-foreground mt-1">
                Accept rent via bank transfer. Tenants pay the owner directly using this IBAN.
              </p>
            </div>
          </button>
        ) : null}

        {formMode === "iban" && (
          <div className="mt-4">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-sm font-semibold text-foreground">
                {editing ? "Edit Bank Details" : "Add IBAN"}
              </h4>
              <button
                type="button"
                onClick={reset}
                aria-label="Cancel"
                className="p-2 hover:bg-muted rounded-lg transition"
              >
                <X size={16} className="text-muted-foreground" />
              </button>
            </div>
            <IbanForm
              holder={holder}
              setHolder={setHolder}
              iban={iban}
              setIban={setIban}
              swift={swift}
              setSwift={setSwift}
              saving={saving}
              editing={editing}
              onSubmit={handleSave}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function IbanForm({
  holder,
  setHolder,
  iban,
  setIban,
  swift,
  setSwift,
  saving,
  editing,
  onSubmit,
}: {
  holder: string;
  setHolder: (v: string) => void;
  iban: string;
  setIban: (v: string) => void;
  swift: string;
  setSwift: (v: string) => void;
  saving: boolean;
  editing: boolean;
  onSubmit: (e: React.FormEvent) => void;
}) {
  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div className="space-y-1.5">
        <label className="text-xs font-bold text-muted-foreground uppercase ml-1">
          Account Holder Name
        </label>
        <input
          type="text"
          required
          value={holder}
          onChange={(e) => setHolder(e.target.value)}
          placeholder="John Doe"
          className="w-full bg-background border border-border rounded-xl px-4 py-3 text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
        />
      </div>
      <div className="space-y-1.5">
        <label className="text-xs font-bold text-muted-foreground uppercase ml-1">IBAN</label>
        <input
          type="text"
          required
          value={iban}
          onChange={(e) => setIban(e.target.value)}
          placeholder="CY00 0000 0000 0000 0000 0000 0000"
          className="w-full bg-background border border-border rounded-xl px-4 py-3 text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 uppercase"
        />
      </div>
      <div className="space-y-1.5">
        <label className="text-xs font-bold text-muted-foreground uppercase ml-1">
          SWIFT / BIC
        </label>
        <input
          type="text"
          required
          value={swift}
          onChange={(e) => setSwift(e.target.value)}
          placeholder="BANKCY2X"
          className="w-full bg-background border border-border rounded-xl px-4 py-3 text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 uppercase"
        />
      </div>
      <button
        type="submit"
        disabled={saving}
        className="w-full bg-primary text-primary-foreground font-bold py-3.5 rounded-xl active:scale-[0.98] transition mt-2 disabled:opacity-70 flex items-center justify-center gap-2"
      >
        {saving && <Loader2 size={16} className="animate-spin" />}
        {saving ? "Saving..." : editing ? "Update Bank Details" : "Save Bank Details"}
      </button>
    </form>
  );
}

// Contextual action bar under the Stripe Account row. 6 ConnectStatus kinds.
function ConnectActions({
  status,
  onContinueOrResolve,
  onRefresh,
  onOpenDashboard,
  busy,
}: {
  status: ReturnType<typeof useConnectStatus>;
  onContinueOrResolve: () => void;
  onRefresh: () => void;
  onOpenDashboard: () => void;
  busy: { connecting: boolean; refreshing: boolean; dashboard: boolean };
}) {
  if (status.kind === "none") return null;

  switch (status.kind) {
    case "active":
      return (
        <div className="mt-3 pt-3 border-t border-border flex flex-wrap items-center gap-2">
          <button
            onClick={onOpenDashboard}
            disabled={busy.dashboard}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-foreground text-background text-xs font-semibold rounded-lg hover:opacity-90 transition disabled:opacity-60"
          >
            {busy.dashboard ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <ExternalLink size={12} />
            )}
            Manage on Stripe
          </button>
          <button
            onClick={onRefresh}
            disabled={busy.refreshing}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-border text-xs font-semibold rounded-lg hover:bg-muted transition disabled:opacity-60 text-muted-foreground"
          >
            {busy.refreshing ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <RefreshCw size={12} />
            )}
            Refresh
          </button>
        </div>
      );

    case "incomplete":
      return (
        <div className="mt-3 pt-3 border-t border-border space-y-2">
          <p className="text-xs text-muted-foreground">
            You started Stripe verification but didn't finish. Pick up where you left off.
          </p>
          <button
            onClick={onContinueOrResolve}
            disabled={busy.connecting}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#635BFF] text-white text-xs font-semibold rounded-lg hover:opacity-90 transition disabled:opacity-60"
          >
            {busy.connecting ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <ExternalLink size={12} />
            )}
            Continue setup
          </button>
        </div>
      );

    case "pendingVerification":
      return (
        <div className="mt-3 pt-3 border-t border-border space-y-2">
          <p className="text-xs text-muted-foreground">
            Stripe is verifying your details. This usually takes a few minutes; sometimes a couple
            of business days.
          </p>
          {status.items.length > 0 && status.items[0] !== "awaiting_stripe_review" && (
            <ul className="text-xs text-muted-foreground space-y-1 ml-3 list-disc">
              {status.items.map((code) => (
                <li key={code}>{requirementLabel(code)}</li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              onClick={onRefresh}
              disabled={busy.refreshing}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-foreground text-background text-xs font-semibold rounded-lg hover:opacity-90 transition disabled:opacity-60"
            >
              {busy.refreshing ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <RefreshCw size={12} />
              )}
              Check status
            </button>
            <button
              onClick={onOpenDashboard}
              disabled={busy.dashboard}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-border text-xs font-semibold rounded-lg hover:bg-muted transition disabled:opacity-60 text-muted-foreground"
            >
              {busy.dashboard ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <ExternalLink size={12} />
              )}
              Manage on Stripe
            </button>
          </div>
        </div>
      );

    case "actionRequired":
      return (
        <div className="mt-3 pt-3 border-t border-border space-y-2">
          <p className="text-xs text-warning">
            Stripe needs the following before deadlines pass — handle these now to keep card
            payments active:
          </p>
          <ul className="text-xs text-warning space-y-1 ml-3 list-disc">
            {status.pastDue.map((code) => (
              <li key={code}>{requirementLabel(code)}</li>
            ))}
          </ul>
          <button
            onClick={onContinueOrResolve}
            disabled={busy.connecting}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-warning text-warning-foreground text-xs font-semibold rounded-lg hover:opacity-90 transition disabled:opacity-60"
          >
            {busy.connecting ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <ExternalLink size={12} />
            )}
            Resolve in Stripe
          </button>
        </div>
      );

    case "restricted":
      return (
        <div className="mt-3 pt-3 border-t border-border space-y-2">
          <p className="text-xs text-destructive">
            Stripe has restricted this account
            {status.reason ? <> ({status.reason})</> : null}. Card payments are paused until this is
            resolved.
          </p>
          <a
            href="mailto:support@oliowallet.com"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-destructive text-destructive-foreground text-xs font-semibold rounded-lg hover:opacity-90 transition"
          >
            Contact support
          </a>
        </div>
      );
  }
}
