import { useState, useEffect } from "react";
import { PAGE_CONTAINER_CLASSNAME } from "@/components/common/AdminLayout";
import {
  Headphones,
  Search,
  Clock,
  CheckCircle2,
  AlertCircle,
  User,
  ChevronRight,
  Send,
  ArrowLeft,
} from "lucide-react";
import { useToast } from "@ui/hooks/use-toast";
import { usePrivileges } from "@ui/lib/usePrivileges";
import { ForbiddenView } from "@ui/components/ForbiddenView";
import { formatDate, formatDateTime } from "@ui/lib/format";
import {
  useAdminTickets,
  useUpdateTicket,
  useReplyToTicket,
  useTicketMessages,
  type AdminTicketRow,
} from "@/lib/adminQueries";

const priorityColors: Record<string, string> = {
  low: "bg-slate-500/10 text-slate-500",
  medium: "bg-yellow-500/10 text-yellow-500",
  high: "bg-orange-500/10 text-orange-500",
  urgent: "bg-red-500/10 text-red-500",
};

const statusColors: Record<string, string> = {
  open: "bg-blue-500/10 text-blue-500",
  in_progress: "bg-yellow-500/10 text-yellow-500",
  resolved: "bg-green-500/10 text-green-500",
  closed: "bg-slate-500/10 text-slate-500",
};

const statusLabels: Record<string, string> = {
  open: "Open",
  in_progress: "In Progress",
  resolved: "Resolved",
  closed: "Closed",
};

const priorityLabels: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
};

export default function AdminSupportPage() {
  const { canPlatform } = usePrivileges();
  const { data: tickets = [] } = useAdminTickets();

  const [searchQuery, setSearchQuery] = useState("");
  const [filterStatus, setFilterStatus] = useState<string>("All");
  const [filterPriority, setFilterPriority] = useState<string>("All");
  const [selectedTicket, setSelectedTicket] = useState<AdminTicketRow | null>(null);
  const [replyText, setReplyText] = useState("");
  const { toast } = useToast();

  const updateTicket = useUpdateTicket();
  const replyMutation = useReplyToTicket();
  const { data: ticketMessages = [] } = useTicketMessages(selectedTicket?.id);

  // Keep selectedTicket in sync with the latest tickets list (e.g. after a
  // mutation refetch refreshes the row).
  useEffect(() => {
    if (!selectedTicket) return;
    const fresh = tickets.find((t) => t.id === selectedTicket.id);
    if (fresh && fresh !== selectedTicket) setSelectedTicket(fresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickets]);

  const filteredTickets = tickets.filter((t) => {
    const q = searchQuery.toLowerCase();
    const matchesSearch =
      t.subject.toLowerCase().includes(q) ||
      t.userName.toLowerCase().includes(q) ||
      t.id.toLowerCase().includes(q);
    const matchesStatus = filterStatus === "All" || statusLabels[t.status] === filterStatus;
    const matchesPriority =
      filterPriority === "All" || priorityLabels[t.priority] === filterPriority;
    return matchesSearch && matchesStatus && matchesPriority;
  });

  const stats = {
    open: tickets.filter((t) => t.status === "open").length,
    inProgress: tickets.filter((t) => t.status === "in_progress").length,
    resolved: tickets.filter((t) => t.status === "resolved").length,
  };

  const formatDay = (iso: string) => formatDate(iso);

  const handleReply = () => {
    if (!selectedTicket || !replyText.trim()) return;
    replyMutation.mutate(
      { ticketId: selectedTicket.id, text: replyText },
      {
        onSuccess: () => {
          setReplyText("");
          toast({ title: "Reply sent" });
        },
        onError: (err: any) =>
          toast({ title: "Send failed", description: err.message, variant: "destructive" }),
      },
    );
  };

  const handleStatusChange = (ticketId: string, newStatus: AdminTicketRow["status"]) => {
    updateTicket.mutate(
      { id: ticketId, patch: { status: newStatus } },
      {
        onSuccess: () =>
          toast({
            title: "Status updated",
            description: `Ticket marked as ${statusLabels[newStatus]}.`,
          }),
        onError: (err: any) =>
          toast({ title: "Update failed", description: err.message, variant: "destructive" }),
      },
    );
  };

  if (!canPlatform("comm.activityLog")) {
    return (
      <div className={PAGE_CONTAINER_CLASSNAME}>
        <ForbiddenView
          title="Support locked"
          message="Your platform role doesn't include the 'View activity log' privilege (used to access support tickets, which carry user PII). An admin can grant it in Settings → Platform Roles."
        />
      </div>
    );
  }

  return (
    <div className={PAGE_CONTAINER_CLASSNAME}>
      {!selectedTicket && (
        <div className="mb-8 md:mb-2 mt-4 md:mt-0">
          <div className="md:hidden">
            <h1 className="text-2xl font-bold text-foreground tracking-tight">Support</h1>
            <p className="text-muted-foreground mt-1 text-sm">Respond to user tickets</p>
          </div>
        </div>
      )}
      {selectedTicket ? (
        /* Ticket Detail View */
        <div>
          <button
            onClick={() => setSelectedTicket(null)}
            className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4 transition"
          >
            <ArrowLeft size={16} />
            Back to tickets
          </button>

          <div className="bg-card border border-border rounded-xl p-5 mb-4">
            <div className="flex items-start justify-between mb-3">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs text-muted-foreground font-mono">
                    {selectedTicket.id}
                  </span>
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full font-medium ${priorityColors[selectedTicket.priority]}`}
                  >
                    {priorityLabels[selectedTicket.priority]}
                  </span>
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColors[selectedTicket.status]}`}
                  >
                    {statusLabels[selectedTicket.status]}
                  </span>
                </div>
                <h2 className="text-lg font-semibold text-foreground">{selectedTicket.subject}</h2>
              </div>
              <select
                value={selectedTicket.status}
                onChange={(e) =>
                  handleStatusChange(selectedTicket.id, e.target.value as AdminTicketRow["status"])
                }
                className="bg-background border border-input rounded-lg px-3 py-1.5 text-sm"
              >
                <option value="open">Open</option>
                <option value="in_progress">In Progress</option>
                <option value="resolved">Resolved</option>
                <option value="closed">Closed</option>
              </select>
            </div>
            <div className="flex items-center gap-4 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <User size={12} /> {selectedTicket.userName}
              </span>
              <span>{selectedTicket.userEmail}</span>
              <span className="flex items-center gap-1">
                <Clock size={12} /> {formatDay(selectedTicket.createdAt)}
              </span>
              <span className="px-2 py-0.5 bg-secondary rounded text-xs">
                {selectedTicket.category}
              </span>
            </div>
          </div>

          {/* Messages */}
          <div className="space-y-3 mb-4">
            {/* Always show the ticket description as the first user-side message */}
            <div className="flex justify-start">
              <div className="max-w-[70%] rounded-xl p-3 bg-card border border-border">
                <p className="text-sm">{selectedTicket.description}</p>
                <p className="text-[10px] mt-1 text-muted-foreground">
                  {formatDateTime(selectedTicket.createdAt)}
                </p>
              </div>
            </div>
            {ticketMessages.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${msg.sender === "agent" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[70%] rounded-xl p-3 ${msg.sender === "agent" ? "bg-primary text-primary-foreground" : "bg-card border border-border"}`}
                >
                  <p className="text-sm">{msg.text}</p>
                  <p
                    className={`text-[10px] mt-1 ${msg.sender === "agent" ? "text-primary-foreground/70" : "text-muted-foreground"}`}
                  >
                    {formatDateTime(msg.createdAt)}
                  </p>
                </div>
              </div>
            ))}
          </div>

          {/* Reply */}
          <div className="bg-card border border-border rounded-xl p-4">
            <textarea
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              placeholder="Type your reply..."
              rows={3}
              className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 resize-none mb-3"
            />
            <div className="flex justify-end">
              <button
                onClick={handleReply}
                disabled={!replyText.trim() || replyMutation.isPending}
                className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Send size={14} />
                {replyMutation.isPending ? "Sending..." : "Send Reply"}
              </button>
            </div>
          </div>
        </div>
      ) : (
        /* Tickets List View */
        <>
          {/* Stats — 1 col on phones (so labels + numbers stay readable), 3 cols from sm. */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
            {[
              { label: "Open", value: stats.open, icon: AlertCircle, color: "text-blue-500" },
              {
                label: "In Progress",
                value: stats.inProgress,
                icon: Clock,
                color: "text-yellow-500",
              },
              {
                label: "Resolved",
                value: stats.resolved,
                icon: CheckCircle2,
                color: "text-green-500",
              },
            ].map((stat) => (
              <div key={stat.label} className="bg-card border border-border rounded-xl p-4">
                <div className="flex items-center gap-2 mb-2">
                  <stat.icon size={16} className={stat.color} />
                  <p className="text-xs text-muted-foreground">{stat.label}</p>
                </div>
                <p className={`text-xl font-bold ${stat.color}`}>{stat.value}</p>
              </div>
            ))}
          </div>

          {/* Search & Filter */}
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 mb-6">
            <div className="relative flex-1 w-full sm:max-w-xs">
              <Search
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <input
                type="text"
                placeholder="Search tickets..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-3 py-2 bg-background border border-input rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
              className="bg-background border border-input rounded-lg px-3 py-2 text-sm"
            >
              <option value="All">All Status</option>
              <option value="Open">Open</option>
              <option value="In Progress">In Progress</option>
              <option value="Resolved">Resolved</option>
              <option value="Closed">Closed</option>
            </select>
            <select
              value={filterPriority}
              onChange={(e) => setFilterPriority(e.target.value)}
              className="bg-background border border-input rounded-lg px-3 py-2 text-sm"
            >
              <option value="All">All Priority</option>
              <option value="Urgent">Urgent</option>
              <option value="High">High</option>
              <option value="Medium">Medium</option>
              <option value="Low">Low</option>
            </select>
          </div>

          {/* Tickets */}
          <div className="space-y-2">
            {filteredTickets.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <Headphones size={40} className="mx-auto mb-3 opacity-30" />
                <p className="text-sm">No tickets found</p>
              </div>
            ) : (
              filteredTickets.map((ticket) => (
                <button
                  key={ticket.id}
                  type="button"
                  onClick={() => setSelectedTicket(ticket)}
                  className="w-full text-left bg-card border border-border rounded-xl p-4 hover:shadow-sm transition cursor-pointer group"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs text-muted-foreground font-mono">{ticket.id}</span>
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full font-medium ${priorityColors[ticket.priority]}`}
                        >
                          {priorityLabels[ticket.priority]}
                        </span>
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColors[ticket.status]}`}
                        >
                          {statusLabels[ticket.status]}
                        </span>
                      </div>
                      <h3 className="text-sm font-medium text-foreground mb-1 truncate">
                        {ticket.subject}
                      </h3>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        <span>{ticket.userName}</span>
                        <span>{ticket.category}</span>
                        <span>{formatDay(ticket.updatedAt)}</span>
                      </div>
                    </div>
                    <ChevronRight
                      size={16}
                      className="text-muted-foreground group-hover:text-foreground transition shrink-0 ml-2"
                    />
                  </div>
                </button>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
