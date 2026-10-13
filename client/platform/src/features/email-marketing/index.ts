// Public surface of the email-marketing feature. Pages compose from here so
// internal slice paths stay encapsulated.

export { CampaignList } from "./ui/CampaignList";
export { CampaignEditor } from "./ui/CampaignEditor";
export { RecipientStatusTable } from "./ui/RecipientStatusTable";
export { useCampaigns } from "./model/useCampaigns";
export { useCampaign } from "./model/useCampaign";
export { deleteDraft } from "./api/campaigns";
export type { EmailCampaign, EmailCampaignStatus } from "./api/types";
