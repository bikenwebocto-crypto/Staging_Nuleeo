export function fmtPct(numerator: number | undefined, denominator: number | undefined): string {
  if (!denominator || denominator <= 0) return "0%";
  const v = ((numerator ?? 0) / denominator) * 100;
  if (!Number.isFinite(v)) return "0%";
  return `${v.toFixed(v >= 10 ? 0 : 1)}%`;
}

export function fmtDate(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

export function fmtDateTime(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" })} · ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
}
