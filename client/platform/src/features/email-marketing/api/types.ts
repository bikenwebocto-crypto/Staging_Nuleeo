// Request/response DTOs for the email-marketing API. These mirror the
// server's `EmailCampaign` / `EmailTemplate` / `EmailRecipient` shapes from
// shared/firestore-schema.ts but kept feature-local so a future server-side
// API change (e.g. added field) doesn't ripple into the rest of the app.

export type {
  EmailCampaign,
  EmailCampaignAudience,
  EmailCampaignStatus,
  EmailCta,
  EmailRecipient,
  EmailRecipientStatus,
  EmailTemplate,
  MarketingAudienceFilter,
  MarketingNumericRange,
} from "@shared/firestore-schema";

import type { EmailCampaignAudience, MarketingAudienceFilter } from "@shared/firestore-schema";

// Discriminated audience selector accepted by create / update endpoints.
// Exactly one of `filter`, `targetUserId`, or `audience` is set per request;
// the server rejects payloads with more than one.
export type CampaignAudienceInput =
  | { filter: MarketingAudienceFilter }
  | { targetUserId: string }
  | { audience: EmailCampaignAudience };

// Optional content extras accepted by create / update. On update, a blank
// signature/footerText or a null cta clears that field server-side.
export interface CampaignContentInput {
  signature?: string;
  footerText?: string;
  cta?: { label: string; url: string } | null;
}

export type CreateCampaignRequest = {
  subject: string;
  bodyText: string;
} & CampaignAudienceInput &
  CampaignContentInput;

export type UpdateCampaignRequest =
  | ({ subject?: string; bodyText?: string } & CampaignContentInput)
  | ({ subject?: string; bodyText?: string } & CampaignAudienceInput & CampaignContentInput);

export interface ScheduleCampaignRequest {
  scheduledAt: string;
}

export interface SendTestRequest {
  email: string;
}

export interface SendTestResponse {
  ok: boolean;
  providerMessageId: string;
}
