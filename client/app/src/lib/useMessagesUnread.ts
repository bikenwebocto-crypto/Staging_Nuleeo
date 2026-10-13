import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@ui/lib/useAuth";

// Minimal shape — we only need the per-row unread the list endpoint projects
// for the caller (unreadByOwner or unreadByTenant, whichever side they're on).
interface UnreadRow {
  unread?: number;
}

// Total unread direct-messages across all of the caller's conversations.
//
// Polled app-wide (from the nav chrome) so the Messages nav item can carry an
// unread badge from ANY page — previously unread was only visible once you
// opened Messages. Shares the ["/api/messages/conversations"] react-query cache
// with MessagesPage, so when that page is open this adds no extra fetch; on
// other pages it's one cheap read per 15s.
export function useMessagesUnread(): number {
  const { firebaseUser } = useAuth();
  const { data } = useQuery<UnreadRow[]>({
    queryKey: ["/api/messages/conversations"],
    enabled: !!firebaseUser,
    refetchInterval: 15000,
    // Let the nav badge update reasonably promptly without thrashing; the 15s
    // poll is the real freshness driver.
    staleTime: 10000,
  });
  return (data ?? []).reduce((sum, c) => sum + (c.unread ?? 0), 0);
}
