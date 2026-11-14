import { useEffect, useMemo, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@ui/components/ui/dialog";
import { cn } from "@ui/lib/utils";
import { parseApiError } from "@ui/lib/queryClient";
import { useToast } from "@ui/hooks/use-toast";
import { BUSINESS_ROLES, BUSINESS_ROLE_LABEL, type BusinessRole } from "@shared/businesses";
import {
  allocationTotal,
  round2,
  validateShareholders,
  type BusinessDetailResponse,
  type ShareholderRowInput,
} from "@shared/shareholdings";
import { useSaveShareholders } from "@/lib/businesses";

// Editable shareholder table. Holders are YOU (your account), an outside
// individual (name + optional email), or one of your companies. Rules are the
// shared validateShareholders(); the server re-validates (incl. circular
// ownership across companies) on save.

type Kind = "YOU" | "PERSON" | "ENTITY";
interface EditRow {
  key: number;
  kind: Kind;
  name: string;
  email: string;
  entityId: string;
  percentText: string;
  role: BusinessRole | "";
}

const INPUT =
  "h-10 w-full rounded-xl bg-[#1C2325] px-3 text-sm text-[#F4F4F2] placeholder:text-[#7D8287] [color-scheme:dark] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#A78C68]";

let nextKey = 1;
function toEditRows(detail: BusinessDetailResponse): EditRow[] {
  return detail.shareholders.map((s) => ({
    key: nextKey++,
    kind: s.isYou ? "YOU" : s.holderType === "ENTITY" ? "ENTITY" : "PERSON",
    name: s.holderName ?? "",
    email: s.holderEmail ?? "",
    entityId: s.holderEntityId ?? "",
    percentText: String(s.percent),
    role: s.role ?? "",
  }));
}

function toInput(r: EditRow, uid: string): ShareholderRowInput {
  const percent =
    r.percentText.trim() === "" ? Number.NaN : Number(r.percentText.replace(",", "."));
  if (r.kind === "ENTITY") return { holderType: "ENTITY", holderEntityId: r.entityId, percent };
  return {
    holderType: "PERSON",
    ...(r.kind === "YOU"
      ? { holderUserId: uid }
      : { holderName: r.name, ...(r.email ? { holderEmail: r.email } : {}) }),
    percent,
    ...(r.role ? { role: r.role } : {}),
  };
}

export function ShareholdersDialog({
  detail,
  uid,
  open,
  onOpenChange,
}: {
  detail: BusinessDetailResponse;
  uid: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const save = useSaveShareholders(detail.business.id);
  const { toast } = useToast();
  const [rows, setRows] = useState<EditRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});

  useEffect(() => {
    if (!open) return;
    setRows(toEditRows(detail));
    setError(null);
    setRowErrors({});
  }, [open, detail]);

  const inputs = useMemo(() => rows.map((r) => toInput(r, uid)), [rows, uid]);
  const total = allocationTotal(inputs);
  const hasYou = rows.some((r) => r.kind === "YOU");
  const usedEntities = new Set(rows.filter((r) => r.kind === "ENTITY").map((r) => r.entityId));

  const patch = (key: number, p: Partial<EditRow>) => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)));
    setRowErrors({});
    setError(null);
  };

  const submit = (complete: boolean) => {
    const checked = validateShareholders(
      inputs,
      {
        callerUid: uid,
        entityId: detail.business.id,
        ownedEntities: detail.companyOptions.map((c) => ({
          id: c.id,
          entityType: "COMPANY" as const,
        })),
        otherHoldings: [],
      },
      { complete },
    );
    if (!checked.ok) {
      setError(checked.error);
      setRowErrors(Object.fromEntries(checked.rowErrors.map((e) => [rows[e.index]?.key, e.error])));
      return;
    }
    save.mutate(
      { shareholders: checked.rows, complete },
      {
        onSuccess: () => {
          toast({ title: complete ? "Ownership confirmed" : "Shareholders saved" });
          onOpenChange(false);
        },
        onError: (err) => setError(parseApiError(err, "Couldn't save shareholders")),
      },
    );
  };

  const remaining = round2(100 - total);
  const tone = total === 100 ? "#7BD88F" : total > 100 ? "#FF7A7A" : "#F5B65C";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] max-w-[720px] overflow-y-auto rounded-3xl border-0 bg-[#111618] p-7 text-[#F4F4F2]">
        <DialogHeader className="text-left">
          <DialogTitle className="text-xl font-semibold">Shareholders</DialogTitle>
          <DialogDescription className="text-sm text-[#A3A7AB]">
            Who owns {detail.business.name}. Save at any time; confirm once the total is exactly
            100%.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <div className="h-2 overflow-hidden rounded-full bg-[#1C2325]" aria-hidden="true">
            <div
              className="h-full rounded-full transition-all"
              style={{ width: `${Math.min(total, 100)}%`, backgroundColor: tone }}
            />
          </div>
          <p className="text-sm" style={{ color: tone }} aria-live="polite">
            {total}% allocated
            {total < 100
              ? ` · ${remaining}% remaining`
              : total > 100
                ? ` · ${round2(total - 100)}% over`
                : " · fully allocated"}
          </p>
        </div>

        <ul className="flex flex-col gap-3">
          {rows.map((r, i) => (
            <li key={r.key} className="rounded-2xl bg-[#1C2325]/60 p-3">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-[150px_1fr_110px_40px]">
                <select
                  aria-label={`Shareholder ${i + 1} type`}
                  className={INPUT}
                  value={r.kind}
                  onChange={(e) =>
                    patch(r.key, {
                      kind: e.target.value as Kind,
                      role: e.target.value === "ENTITY" ? "" : r.role,
                    })
                  }
                >
                  <option value="YOU" disabled={hasYou && r.kind !== "YOU"}>
                    You
                  </option>
                  <option value="PERSON">Person</option>
                  <option value="ENTITY" disabled={detail.companyOptions.length === 0}>
                    Company
                  </option>
                </select>

                {r.kind === "ENTITY" ? (
                  <select
                    aria-label={`Shareholder ${i + 1} company`}
                    className={INPUT}
                    value={r.entityId}
                    onChange={(e) => patch(r.key, { entityId: e.target.value })}
                  >
                    <option value="">Choose a company…</option>
                    {detail.companyOptions.map((c) => (
                      <option
                        key={c.id}
                        value={c.id}
                        disabled={usedEntities.has(c.id) && r.entityId !== c.id}
                      >
                        {c.name}
                      </option>
                    ))}
                  </select>
                ) : r.kind === "PERSON" ? (
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      aria-label={`Shareholder ${i + 1} name`}
                      className={INPUT}
                      placeholder="Full name"
                      value={r.name}
                      onChange={(e) => patch(r.key, { name: e.target.value })}
                    />
                    <input
                      aria-label={`Shareholder ${i + 1} email`}
                      className={INPUT}
                      placeholder="Email (optional)"
                      type="email"
                      value={r.email}
                      onChange={(e) => patch(r.key, { email: e.target.value })}
                    />
                  </div>
                ) : (
                  <span className="flex h-10 items-center px-1 text-sm text-[#A3A7AB]">
                    Your account
                  </span>
                )}

                <div className="relative">
                  <input
                    aria-label={`Shareholder ${i + 1} percentage`}
                    inputMode="decimal"
                    className={cn(INPUT, "pr-7 text-right tabular-nums")}
                    value={r.percentText}
                    onChange={(e) => patch(r.key, { percentText: e.target.value })}
                    placeholder="0"
                  />
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-[#7D8287]">
                    %
                  </span>
                </div>

                <button
                  type="button"
                  aria-label={`Remove shareholder ${i + 1}`}
                  onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
                  className="flex h-10 w-10 items-center justify-center rounded-xl text-[#A3A7AB] hover:bg-[#2A3134] hover:text-[#FF7A7A]"
                >
                  <Trash2 size={16} aria-hidden="true" />
                </button>
              </div>
              {r.kind !== "ENTITY" && (
                <select
                  aria-label={`Shareholder ${i + 1} role`}
                  className={cn(INPUT, "mt-2 sm:w-[260px]")}
                  value={r.role}
                  onChange={(e) => patch(r.key, { role: e.target.value as BusinessRole | "" })}
                >
                  <option value="">Role (optional)</option>
                  {BUSINESS_ROLES.map((x) => (
                    <option key={x} value={x}>
                      {BUSINESS_ROLE_LABEL[x]}
                    </option>
                  ))}
                </select>
              )}
              {rowErrors[r.key] && (
                <p className="mt-2 text-xs text-[#FF7A7A]">{rowErrors[r.key]}</p>
              )}
            </li>
          ))}
        </ul>

        <button
          type="button"
          onClick={() =>
            setRows((rs) => [
              ...rs,
              {
                key: nextKey++,
                kind: hasYou ? "PERSON" : "YOU",
                name: "",
                email: "",
                entityId: "",
                percentText: remaining > 0 ? String(remaining) : "",
                role: "",
              },
            ])
          }
          className="flex w-fit items-center gap-2 rounded-full bg-[#1C2325] px-4 py-2 text-sm font-semibold hover:bg-[#2A3134]"
        >
          <Plus size={14} aria-hidden="true" /> Add shareholder
        </button>

        {error && (
          <p role="alert" className="rounded-2xl bg-[#FF7A7A]/10 px-4 py-3 text-sm text-[#FF7A7A]">
            {error}
          </p>
        )}

        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="h-11 rounded-full bg-white/[0.08] px-6 text-sm font-semibold hover:bg-white/[0.12]"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={save.isPending}
            onClick={() => submit(false)}
            className="h-11 rounded-full bg-[#1C2325] px-6 text-sm font-semibold hover:bg-[#2A3134] disabled:opacity-60"
          >
            Save
          </button>
          <button
            type="button"
            disabled={save.isPending || total !== 100}
            title={total !== 100 ? "The total must be exactly 100%" : undefined}
            onClick={() => submit(true)}
            className="ml-auto flex h-11 items-center gap-2 rounded-full bg-white px-6 text-sm font-semibold text-[#060A0B] hover:brightness-95 disabled:opacity-50"
          >
            {save.isPending && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
            Confirm allocation
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
