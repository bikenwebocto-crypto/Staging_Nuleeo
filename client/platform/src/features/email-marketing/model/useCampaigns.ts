// Campaign-list state with refresh-after-mutation. The platform consumer
// reads the list, fires a mutation, and asks for a reload — we don't lean
// on Firestore onSnapshot because firestore.rules deny direct client reads
// on emailCampaigns. The HTTP read is fast enough for a 100-row admin list.

import { useCallback, useEffect, useState } from "react";
import { listCampaigns } from "../api/campaigns";
import type { EmailCampaign, EmailCampaignStatus } from "../api/types";

export interface UseCampaignsState {
  campaigns: EmailCampaign[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

export function useCampaigns(statusFilter?: EmailCampaignStatus): UseCampaignsState {
  const [campaigns, setCampaigns] = useState<EmailCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listCampaigns(statusFilter);
      setCampaigns(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load campaigns");
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { campaigns, loading, error, reload };
}
