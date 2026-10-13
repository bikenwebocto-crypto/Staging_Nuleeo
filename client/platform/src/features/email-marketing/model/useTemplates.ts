import { useCallback, useEffect, useState } from "react";
import { listTemplates } from "../api/templates";
import type { EmailTemplate } from "../api/types";

export interface UseTemplatesState {
  templates: EmailTemplate[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

export function useTemplates(): UseTemplatesState {
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setTemplates(await listTemplates());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load templates");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { templates, loading, error, reload };
}
