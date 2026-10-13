// Preview-time merge-var substitution. Mirrors server/services/mergeVars.ts
// so the inbox renders identically to the editor preview.

export interface PreviewContext {
  firstName?: string;
  lastName?: string;
  email?: string;
  now?: Date;
}

export function renderPreview(template: string, ctx: PreviewContext = {}): string {
  const now = ctx.now ?? new Date();
  const date = now.toISOString().slice(0, 10);
  const first = ctx.firstName?.trim() || "";
  const last = ctx.lastName?.trim() || "";
  const name = first || "there";
  return template
    .replace(/\{\{\s*name\s*\}\}/g, name)
    .replace(/\{\{\s*first_name\s*\}\}/g, first)
    .replace(/\{\{\s*last_name\s*\}\}/g, last)
    .replace(/\{\{\s*date\s*\}\}/g, date)
    .replace(/\{\{\s*email\s*\}\}/g, ctx.email ?? "you@example.com")
    .replace(/\{\{\s*unsubscribe_url\s*\}\}/g, "#unsubscribe");
}
