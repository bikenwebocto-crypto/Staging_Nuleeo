import { useCallback, useEffect, useState } from "react";
import { getCampaign } from "../api/campaigns";
import type { EmailCampaign, EmailRecipient } from "../api/types";

export interface UseCampaignState {
  campaign: EmailCampaign | null;
  recipients: EmailRecipient[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

export function useCampaign(id: string | null): UseCampaignState {
  const [campaign, setCampaign] = useState<EmailCampaign | null>(null);
  const [recipients, setRecipients] = useState<EmailRecipient[]>([]);
  const [loading, setLoading] = useState<boolean>(Boolean(id));
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!id) {
      setCampaign(null);
      setRecipients([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { campaign: c, recipients: r } = await getCampaign(id);
      setCampaign(c);
      setRecipients(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load campaign");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { campaign, recipients, loading, error, reload };
}
