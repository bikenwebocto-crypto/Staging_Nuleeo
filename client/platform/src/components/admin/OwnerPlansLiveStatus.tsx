// Stripe live-health panel for Settings → Integrations. Shows platform
// account, Connect, and webhook status. Plan name / description are edited
// in the Owner Plans matrix (Limits & Fees rows); yearly prices are FIXED
// in code (DEFAULT_PLAN_LABELS) and shown read-only there.
//
// The owner-plan Stripe products are a one-time setup, created at the fixed
// €69 / €290 price (POST /api/admin/stripe/provision-plan-products) — there
// is no in-panel "create products" button: products are provisioned once and
// then left alone, so this panel is read-only health status.

import { useEffect, useState } from "react";
import { AlertTriangle, Check, RefreshCw } from "lucide-react";
import { apiRequest } from "@ui/lib/queryClient";

interface ProductInfo {
  productId: string;
  productName: string;
  active: boolean;
  priceId: string | null;
  amount: number | null;
  currency: string | null;
  interval: string | null;
}

interface WebhookEndpoint {
  id: string;
  url: string;
  status: string;
  events: string[];
  missingEvents: string[];
  connect: boolean;
}

interface LiveHealth {
  configured: boolean;
  mode: "live" | "test" | null;
  account: {
    id: string;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    detailsSubmitted: boolean;
    country: string | null;
    defaultCurrency: string | null;
    businessName: string | null;
  } | null;
  connect: {
    enabled: boolean;
    connectedAccountsCount: number;
    error?: string;
  };
  products: { advance: ProductInfo | null; pro: ProductInfo | null };
  webhooks: { endpoints: WebhookEndpoint[]; requiredEvents: string[] };
}

export function OwnerPlansLiveStatus() {
  const [health, setHealth] = useState<LiveHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAll = async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    setError(null);
    try {
      const hRes = await apiRequest("GET", "/api/admin/stripe/live-health");
      const h = (await hRes.json()) as LiveHealth;
      setHealth(h);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchAll();
  }, []);

  if (loading) {
    return (
      <div className="bg-card p-5 rounded-xl border border-border shadow-sm mb-4">
        <p className="text-xs text-muted-foreground">Loading…</p>
      </div>
    );
  }
  if (error || !health) {
    return (
      <div className="bg-card p-5 rounded-xl border border-border shadow-sm mb-4">
        <p className="text-xs text-red-600">{error ?? "No data"}</p>
      </div>
    );
  }

  const modeBadge = !health.configured ? (
    <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-700 bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded-full uppercase tracking-wider">
      <AlertTriangle size={11} /> Not configured
    </span>
  ) : health.mode === "live" ? (
    <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded-full uppercase tracking-wider">
      <Check size={11} /> Live
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-700 bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded-full uppercase tracking-wider">
      <AlertTriangle size={11} /> Test mode
    </span>
  );

  // Model B needs BOTH endpoints live: a platform endpoint (connect:false)
  // for account/subscription events, and a Connect endpoint (connect:true)
  // for the direct-charge events that fire on owners' accounts. Each must be
  // enabled with no missing events — a single green endpoint isn't enough.
  const platformEp = health.webhooks.endpoints.find((e) => !e.connect);
  const connectEp = health.webhooks.endpoints.find((e) => e.connect);
  const epOk = (e?: WebhookEndpoint) =>
    !!e && e.status === "enabled" && e.missingEvents.length === 0;
  const webhookOk = epOk(platformEp) && epOk(connectEp);

  return (
    <div className="bg-card p-5 rounded-xl border border-border shadow-sm mb-4">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-sm font-semibold text-foreground">Stripe live status</h3>
            {modeBadge}
          </div>
          <p className="text-xs text-muted-foreground">
            Plan names, descriptions, unit caps, and commissions are edited in the Owner Plans
            matrix. Prices are fixed and shown read-only.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => fetchAll(true)}
            disabled={refreshing}
            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-muted/50 transition disabled:opacity-50"
          >
            <RefreshCw size={12} className={refreshing ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        <HealthChip
          label="Platform account"
          ok={!!health.account?.chargesEnabled}
          detail={
            health.account
              ? `${health.account.businessName ?? health.account.id} · ${
                  health.account.country ?? "?"
                } · ${health.account.defaultCurrency ?? "?"}`
              : "No account info"
          }
        />
        <HealthChip
          label="Connect (split payments)"
          ok={health.connect.enabled}
          detail={
            health.connect.enabled
              ? `${health.connect.connectedAccountsCount}${
                  health.connect.connectedAccountsCount === 100 ? "+" : ""
                } connected owner${health.connect.connectedAccountsCount === 1 ? "" : "s"}`
              : (health.connect.error ?? "Connect not enabled on this Stripe account")
          }
        />
        <HealthChip
          label="Webhook endpoint"
          ok={webhookOk}
          detail={
            webhookOk
              ? "Platform + Connect endpoints configured"
              : !platformEp
                ? 'Add the "Your account" (platform) endpoint'
                : !connectEp
                  ? 'Add the "Connected accounts" (Connect) endpoint'
                  : `Missing: ${[...platformEp.missingEvents, ...connectEp.missingEvents].join(", ") || "—"}`
          }
        />
      </div>
    </div>
  );
}

function HealthChip({ label, ok, detail }: { label: string; ok: boolean; detail: string }) {
  return (
    <div
      className={`flex items-start gap-2 px-3 py-2.5 rounded-lg border text-xs ${
        ok ? "bg-emerald-500/5 border-emerald-500/20" : "bg-amber-500/5 border-amber-500/20"
      }`}
    >
      {ok ? (
        <Check size={14} className="text-emerald-600 mt-0.5 shrink-0" />
      ) : (
        <AlertTriangle size={14} className="text-amber-600 mt-0.5 shrink-0" />
      )}
      <div className="min-w-0">
        <div className="font-medium text-foreground">{label}</div>
        <div className="text-[11px] text-muted-foreground truncate">{detail}</div>
      </div>
    </div>
  );
}
