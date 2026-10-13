// Campaign CRUD + lifecycle calls. Thin wrappers around apiRequest so the
// rest of the feature stays JSON-shape-aware without sprinkling fetch
// boilerplate everywhere.

import { apiRequest } from "@ui/lib/queryClient";
import type {
  CreateCampaignRequest,
  EmailCampaign,
  EmailCampaignStatus,
  EmailRecipient,
  MarketingAudienceFilter,
  ScheduleCampaignRequest,
  SendTestRequest,
  SendTestResponse,
  UpdateCampaignRequest,
} from "./types";

export async function listCampaigns(status?: EmailCampaignStatus): Promise<EmailCampaign[]> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  const res = await apiRequest("GET", `/api/admin/emails${qs}`);
  return res.json();
}

export async function getCampaign(id: string): Promise<{
  campaign: EmailCampaign;
  recipients: EmailRecipient[];
}> {
  const res = await apiRequest("GET", `/api/admin/emails/${id}`);
  return res.json();
}

export async function listRecipients(
  id: string,
  cursor?: string | null,
  limit = 50,
): Promise<{ recipients: EmailRecipient[]; nextCursor: string | null }> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set("cursor", cursor);
  const res = await apiRequest("GET", `/api/admin/emails/${id}/recipients?${params}`);
  return res.json();
}

export async function createDraft(input: CreateCampaignRequest): Promise<EmailCampaign> {
  const res = await apiRequest("POST", "/api/admin/emails", input);
  return res.json();
}

export async function updateDraft(
  id: string,
  patch: UpdateCampaignRequest,
): Promise<EmailCampaign> {
  const res = await apiRequest("PATCH", `/api/admin/emails/${id}`, patch);
  return res.json();
}

export async function deleteDraft(id: string): Promise<void> {
  await apiRequest("DELETE", `/api/admin/emails/${id}`);
}

export async function sendNow(id: string): Promise<EmailCampaign> {
  const res = await apiRequest("POST", `/api/admin/emails/${id}/send`);
  return res.json();
}

export async function schedule(id: string, input: ScheduleCampaignRequest): Promise<EmailCampaign> {
  const res = await apiRequest("POST", `/api/admin/emails/${id}/schedule`, input);
  return res.json();
}

export async function cancel(id: string): Promise<EmailCampaign> {
  const res = await apiRequest("POST", `/api/admin/emails/${id}/cancel`);
  return res.json();
}

export async function sendTest(id: string, input: SendTestRequest): Promise<SendTestResponse> {
  const res = await apiRequest("POST", `/api/admin/emails/${id}/test`, input);
  return res.json();
}

// Audience-count preview used by the editor while the admin tweaks filters.
// Hits the same endpoint as the notification surface but resolves through the
// "email" channel (i.e. respects the marketingEmails opt-out).
export async function fetchAudienceCount(filter: MarketingAudienceFilter): Promise<number> {
  const res = await apiRequest("POST", "/api/admin/emails/audience-count", filter);
  const data = (await res.json()) as { count: number };
  return data.count;
}
