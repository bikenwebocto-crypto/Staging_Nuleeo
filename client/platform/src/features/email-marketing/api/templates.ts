// Reusable subject + body templates. Templates are pure content; the admin
// applies them to a campaign by copying subject/body into the editor.

import { apiRequest } from "@ui/lib/queryClient";
import type { EmailTemplate } from "./types";

export async function listTemplates(): Promise<EmailTemplate[]> {
  const res = await apiRequest("GET", "/api/admin/emails/templates");
  return res.json();
}

export async function createTemplate(input: {
  name: string;
  subject: string;
  body: string;
}): Promise<EmailTemplate> {
  const res = await apiRequest("POST", "/api/admin/emails/templates", input);
  return res.json();
}

export async function updateTemplate(
  id: string,
  patch: { name?: string; subject?: string; body?: string },
): Promise<EmailTemplate> {
  const res = await apiRequest("PATCH", `/api/admin/emails/templates/${id}`, patch);
  return res.json();
}

export async function deleteTemplate(id: string): Promise<void> {
  await apiRequest("DELETE", `/api/admin/emails/templates/${id}`);
}
