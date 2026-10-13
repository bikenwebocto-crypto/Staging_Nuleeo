// Owner ↔ tenant direct messages. Shared between /owner/messages and
// /tenant/messages — the data model is symmetric (counter-party shown on
// the other side, same endpoints), so we render one component.
//
// Layout: left pane lists conversations with unread counters; right pane
// shows the selected thread + a composer. On narrow screens the right
// pane stacks below.

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useSearch } from "wouter";
import { ChevronLeft, Loader2, MessageSquare, Pin, Send, Sparkles } from "lucide-react";
import { apiRequest, parseApiError } from "@ui/lib/queryClient";
import { useAuth } from "@ui/lib/useAuth";
import { useToast } from "@ui/hooks/use-toast";
import { useIsMobile } from "@ui/hooks/use-mobile";
import { formatDateNumeric } from "@ui/lib/format";
import { useHideBottomNav, useHideMobileHeader } from "@/components/common/AppLayout";
import { AskOlioContent } from "@ui/components/common/AskOlioDrawer";
import type { ConversationMessage } from "@shared/firestore-schema";

// Synthetic id for the pinned "Ask Olio" entry. It isn't a real conversation
// (no Firestore doc, no counterpart) — selecting it swaps the right pane for
// the AI chat instead of a message thread.
const ASK_OLIO_ID = "ask-olio";

interface ConversationRow {
  id: string;
  ownerId: string;
  tenantUserId: string;
  tenancyId: string;
  propertyId: string;
  lastMessageText: string;
  lastMessageAt: string;
  lastMessageSenderId: string;
  unreadByOwner: number;
  unreadByTenant: number;
  createdAt: string;
  counterpartUserId: string;
  counterpartName: string;
  unread: number;
}

function formatTime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    // Today: show 24h time, en-IE for consistency with shared helpers.
    return d.toLocaleTimeString("en-IE", { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  return formatDateNumeric(iso);
}

// Initials for the counterpart avatar disc. Derived from the display name only
// (no avatar URL on ConversationRow): first letter of the first + last token,
// or the first letter for a single token. Returns "" for an empty name so the
// caller renders an empty disc rather than garbage — this never applies to the
// Ask Olio row, which keeps its Sparkles chip.
function initialsFor(name: string): string {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export default function MessagesPage() {
  const { firebaseUser } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [location] = useLocation();
  const search = useSearch();
  const isTenantView = location.startsWith("/tenant");
  // Seed from the ?c=<id> deep link so an in-app Chat button (where the
  // conversations list is usually already cached) opens straight into the
  // thread on the first render — no flash of the inbox chrome. The effect
  // below still handles the param changing after mount.
  const [activeId, setActiveId] = useState<string | null>(() =>
    new URLSearchParams(search).get("c"),
  );
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  // While > Date.now() the composer is rate-limited (a 429 came back); send is
  // disabled until it lapses. A timer effect below resets it so the UI
  // re-enables itself without a poll.
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Monotonic id for optimistic (not-yet-saved) messages so the echo can be
  // reconciled/removed without colliding with a real Firestore message id.
  const optimisticSeq = useRef(0);
  const isMobile = useIsMobile();

  // Deep link: the owner-side Chat buttons (tenant profile, tenants page,
  // agreements) land here with ?c=<conversationId> so the RIGHT thread
  // opens. Without this they'd fall through to the auto-select below,
  // which picks the most recently active thread — a different tenant.
  useEffect(() => {
    const wanted = new URLSearchParams(search).get("c");
    if (wanted) setActiveId(wanted);
  }, [search]);

  const { data: conversations = [], isLoading: convLoading } = useQuery<ConversationRow[]>({
    queryKey: ["/api/messages/conversations"],
    // Poll while the tab is open so new messages from the other side show
    // up without a manual refresh. Cheap — one read per 15s per open tab.
    refetchInterval: 15000,
  });

  // Auto-select the most recent conversation — but only on desktop, where the
  // list stays visible beside the thread. On mobile (master/detail) we land on
  // the list so the user sees their inbox first instead of being dropped
  // straight into a thread.
  //
  // The breakpoint is read SYNCHRONOUSLY here (not from useIsMobile, which is
  // `false` until its own effect resolves): with a warm conversations cache the
  // effect can fire on the very first paint, and a stale `false` would drop a
  // mobile user straight into a thread. `isMobile` stays in the deps purely so
  // a later resize across the breakpoint re-runs this and auto-selects.
  useEffect(() => {
    if (activeId || conversations.length === 0) return;
    const isDesktop =
      typeof window !== "undefined" && window.matchMedia("(min-width: 768px)").matches;
    if (isDesktop) setActiveId(conversations[0].id);
  }, [conversations, activeId, isMobile]);

  // Re-enable the composer once a 429 cooldown lapses.
  useEffect(() => {
    if (cooldownUntil <= 0) return;
    const ms = cooldownUntil - Date.now();
    if (ms <= 0) {
      setCooldownUntil(0);
      return;
    }
    const t = setTimeout(() => setCooldownUntil(0), ms);
    return () => clearTimeout(t);
  }, [cooldownUntil]);

  const isAskOlio = activeId === ASK_OLIO_ID;
  const activeConv = conversations.find((c) => c.id === activeId) ?? null;
  // Master/detail on mobile: the grid stacks to one column, so showing both
  // panes would push the open chat below the whole list (a tap on the pinned
  // Ask Olio row would appear to do nothing). When something is selected we
  // show only the detail pane on phones; desktop keeps both columns.
  const showDetail = isAskOlio || !!activeConv;

  // Full-screen messaging on mobile: while a thread is open, hide both the
  // global mobile top bar and the floating bottom nav so the chat (header +
  // messages + composer) owns the whole viewport. Both hooks are no-ops on
  // desktop, where that chrome is already md:hidden. On the conversation list
  // (no thread) we keep the chrome so search/notifications/nav stay reachable.
  useHideMobileHeader(showDetail);
  useHideBottomNav(showDetail);

  // Mobile chat = a full-screen overlay pinned to the VISUAL viewport so the
  // header stays stuck to the top, the composer sticks to the bottom (and rides
  // up to sit on top of the on-screen keyboard), and only the messages scroll
  // in between. The layout viewport (100dvh) does NOT shrink when the keyboard
  // opens, so a normal bottom footer would hide behind it — tracking
  // window.visualViewport is the fix (same trick the ResponsiveDrawer uses).
  const mobileImmersive = isMobile && showDetail;
  const [viewport, setViewport] = useState<{ top: number; height: number } | null>(null);
  useEffect(() => {
    if (!mobileImmersive) {
      setViewport(null);
      return;
    }
    const vv = window.visualViewport;
    const update = () =>
      setViewport(
        vv ? { top: vv.offsetTop, height: vv.height } : { top: 0, height: window.innerHeight },
      );
    update();
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, [mobileImmersive]);

  // Lock the whole app to the viewport while Messages is open on mobile — BOTH
  // the conversation list and an open thread. The page itself must never scroll;
  // only the inner scroll regions (the list, or a thread's messages) do.
  useEffect(() => {
    if (!isMobile) return;
    const scroller = document.querySelector<HTMLElement>("[data-app-scroll]");
    const prevScroller = scroller?.style.overflow ?? "";
    const prevBody = document.body.style.overflow;
    const prevHtml = document.documentElement.style.overflow;
    if (scroller) scroller.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    return () => {
      if (scroller) scroller.style.overflow = prevScroller;
      document.body.style.overflow = prevBody;
      document.documentElement.style.overflow = prevHtml;
    };
  }, [isMobile]);

  // iOS Safari IGNORES overflow:hidden for document/touch scrolling, so the page
  // still rubber-bands. The only reliable lock is to intercept touchmove and
  // preventDefault everywhere EXCEPT inside an allowed scroll region (marked
  // data-chat-scroll — the conversation list or a thread's messages) and the
  // composer. Non-passive listener so preventDefault actually takes effect.
  useEffect(() => {
    if (!isMobile) return;
    const onTouchMove = (e: TouchEvent) => {
      let el = e.target as HTMLElement | null;
      while (el) {
        if (el.dataset?.chatScroll !== undefined) return; // list / messages → allow
        // Allow the composer to scroll ONLY when the draft actually overflows.
        // Otherwise a drag on the input lets iOS scroll the page and shove the
        // fixed overlay upward (the "input jumps higher when you drag it" bug).
        if (el.tagName === "TEXTAREA" && el.scrollHeight > el.clientHeight + 1) return;
        el = el.parentElement;
      }
      e.preventDefault(); // header, footer, composer (when not overflowing), empty space
    };
    document.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => document.removeEventListener("touchmove", onTouchMove);
  }, [isMobile]);

  const { data: messages = [], isLoading: msgsLoading } = useQuery<ConversationMessage[]>({
    queryKey: [`/api/messages/conversations/${activeId}/messages`],
    // Skip for the synthetic Ask Olio entry — it has no message thread on the
    // server; its right pane is the AI chat, which fetches via /api/ask.
    enabled: !!activeId && !isAskOlio,
    refetchInterval: activeId && !isAskOlio ? 5000 : false,
    // The global default is staleTime: Infinity, which would show the last
    // cached page (missing anything sent since) with no spinner when a thread
    // is re-opened. Force a refetch-on-mount so re-entering a thread always
    // pulls fresh messages.
    staleTime: 0,
  });

  // Scroll to bottom when the active conversation changes or new messages
  // arrive — the standard chat UX.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length, activeId]);

  // Mark read whenever the user opens (or receives into) a conversation that
  // has unread. We wait until the messages are loaded so we can send the
  // server a watermark — the createdAt of the newest message we've actually
  // rendered — and the server only zeroes the counter when nothing newer has
  // arrived, so a message landing mid-read isn't silently marked read. On a
  // confirmed clear we optimistically zero this row in the list cache (instead
  // of refetching), which avoids the badge flickering N↔0 on each poll.
  useEffect(() => {
    if (!activeConv) return;
    if ((activeConv.unread ?? 0) === 0) return;
    if (msgsLoading) return;
    const convId = activeConv.id;
    // Watermark = newest SERVER-CONFIRMED message. Skip optimistic echoes
    // (client-clock createdAt) — a forward-skewed client clock could otherwise
    // push the watermark past an unrendered incoming message and over-clear it.
    const serverMessages = messages.filter((m) => !m.id.startsWith("optimistic-"));
    const lastSeenAt = serverMessages.length
      ? serverMessages[serverMessages.length - 1].createdAt
      : undefined;
    apiRequest(
      "POST",
      `/api/messages/conversations/${convId}/read`,
      lastSeenAt ? { lastSeenAt } : undefined,
    )
      .then(async (res) => {
        const body = (await res.json().catch(() => ({ cleared: true }))) as { cleared?: boolean };
        if (body.cleared === false) return;
        qc.setQueryData<ConversationRow[]>(["/api/messages/conversations"], (old) =>
          old?.map((c) =>
            c.id === convId ? { ...c, unread: 0, unreadByOwner: 0, unreadByTenant: 0 } : c,
          ),
        );
      })
      .catch(() => undefined);
  }, [activeConv?.id, activeConv?.unread, msgsLoading, messages, qc]);

  const handleSend = async () => {
    // Guard the keyboard path too — the Send button is disabled while in-flight
    // or rate-limited, but Enter-to-send isn't, so without this an Enter-mash on
    // a slow link could fire several sends.
    if (!activeId || sending || Date.now() < cooldownUntil) return;
    const text = draft.trim();
    if (!text) return;
    setSending(true);
    const msgsKey = [`/api/messages/conversations/${activeId}/messages`];
    // Optimistic echo: render the message immediately so the sender doesn't wait
    // a network round-trip (and up to a 5s poll) to see their own message. We
    // reconcile it with the server's saved doc on success, or roll it back and
    // restore the draft on failure.
    const optimisticId = `optimistic-${(optimisticSeq.current += 1)}`;
    const optimistic: ConversationMessage = {
      id: optimisticId,
      conversationId: activeId,
      senderId: firebaseUser?.uid ?? "",
      text,
      createdAt: new Date().toISOString(),
    };
    setDraft("");
    qc.setQueryData<ConversationMessage[]>(msgsKey, (old = []) => [...old, optimistic]);
    try {
      const res = await apiRequest("POST", `/api/messages/conversations/${activeId}/messages`, {
        text,
      });
      const saved = (await res.json()) as ConversationMessage;
      qc.setQueryData<ConversationMessage[]>(msgsKey, (old = []) => {
        // Normal case: swap the optimistic echo for the saved doc. But a 5s poll
        // can land between the echo-add and here and replace the cache without
        // the echo — then map() is a no-op and the message would vanish until
        // the next poll. Guard: if the echo is gone and the saved id isn't
        // present yet, append it.
        if (old.some((m) => m.id === optimisticId)) {
          return old.map((m) => (m.id === optimisticId ? saved : m));
        }
        return old.some((m) => m.id === saved.id) ? old : [...old, saved];
      });
      qc.invalidateQueries({ queryKey: ["/api/messages/conversations"] });
    } catch (err) {
      // Roll the optimistic echo back and give the draft back so the text isn't
      // lost.
      qc.setQueryData<ConversationMessage[]>(msgsKey, (old = []) =>
        old.filter((m) => m.id !== optimisticId),
      );
      setDraft((d) => d || text);
      const raw = err instanceof Error ? err.message : "";
      const status = Number(raw.match(/^(\d+):/)?.[1]);
      if (status === 429) {
        let retryAfter = 30;
        try {
          const parsed = JSON.parse(raw.replace(/^\d+:\s*/, "")) as { retryAfterSeconds?: number };
          if (typeof parsed.retryAfterSeconds === "number") retryAfter = parsed.retryAfterSeconds;
        } catch {
          /* keep default */
        }
        setCooldownUntil(Date.now() + retryAfter * 1000);
        toast({
          title: "Slow down",
          description: `You're sending too quickly. Try again in ${retryAfter}s.`,
          variant: "destructive",
        });
      } else {
        toast({
          title: "Could not send",
          description: parseApiError(err, "Send failed"),
          variant: "destructive",
        });
      }
    } finally {
      setSending(false);
    }
  };

  const rateLimited = cooldownUntil > Date.now();

  return (
    <div className="flex flex-col h-full md:p-8">
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden md:grid md:grid-cols-[300px_1fr] md:grid-rows-[minmax(0,1fr)] md:bg-card md:rounded-2xl md:shadow-sm md:border md:border-border">
        {/* Conversation list */}
        <aside
          className={`bg-card border-b md:border-b-0 md:border-r border-border min-h-0 flex-col ${
            showDetail ? "hidden md:flex" : "flex flex-1 md:flex"
          }`}
        >
          {/* Mobile-only "Messages" title. On the list view the global top bar
              is still shown, so clear its full height; inside a thread the bar
              is hidden and the thread renders its own header instead. */}
          <div className="md:hidden px-5 pt-[var(--mobile-header-clearance)] pb-3 border-b border-border">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">Messages</h1>
          </div>

          {/* Scroll region: fills the pane and scrolls independently on both
              mobile and the full-height desktop card. Flex column so the
              empty/loading states can grow to fill an otherwise empty pane.
              data-chat-scroll marks it as an allowed scroll area for the mobile
              touch-lock (everything else on the page is frozen). */}
          <div
            data-chat-scroll
            className="flex flex-col flex-1 min-h-0 overflow-y-auto overscroll-contain"
          >
            {/* Pinned Ask Olio — owner-only AI assistant, always at the top. */}
            {!isTenantView && (
              <button
                type="button"
                onClick={() => setActiveId(ASK_OLIO_ID)}
                className={`w-full text-left px-4 py-3 border-b border-border transition flex items-center gap-3 ${
                  isAskOlio ? "bg-muted" : "hover:bg-muted/40"
                }`}
              >
                <div className="w-9 h-9 rounded-full bg-foreground text-background flex items-center justify-center shrink-0">
                  <Sparkles size={16} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-sm text-foreground truncate">Ask Olio</span>
                    <Pin size={11} className="text-muted-foreground shrink-0 fill-current" />
                  </div>
                  <p className="text-xs text-muted-foreground truncate">
                    Your AI property assistant
                  </p>
                </div>
              </button>
            )}

            {convLoading ? (
              <div className="p-6 flex items-center justify-center text-muted-foreground">
                <Loader2 size={18} className="animate-spin" />
              </div>
            ) : conversations.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center p-6 text-center text-sm text-muted-foreground">
                <MessageSquare size={22} className="mx-auto mb-2 opacity-60" />
                <p>No conversations yet.</p>
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {conversations.map((c) => {
                  const isActive = c.id === activeId;
                  return (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => setActiveId(c.id)}
                        className={`w-full text-left px-4 py-3 transition flex items-center gap-3 ${
                          isActive ? "bg-muted" : "hover:bg-muted/40"
                        }`}
                      >
                        <div className="w-9 h-9 rounded-full bg-muted text-foreground border border-border flex items-center justify-center shrink-0 text-xs font-semibold uppercase">
                          {initialsFor(c.counterpartName)}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium text-sm text-foreground truncate">
                              {c.counterpartName}
                            </span>
                            {/* Hide the pill for the thread you're currently
                                viewing — it's being marked read, so a lingering
                                count would just flicker N↔0 on each poll. */}
                            {c.unread > 0 && c.id !== activeId && (
                              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-primary text-primary-foreground shrink-0">
                                {c.unread}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center justify-between gap-2 mt-0.5">
                            <span
                              className={`text-xs text-muted-foreground truncate flex-1 ${
                                c.lastMessageSenderId ? "" : "italic"
                              }`}
                            >
                              {c.lastMessageText || "No messages yet"}
                            </span>
                            {/* An untouched thread's lastMessageAt is just its
                              creation time — showing it would read as message
                              activity that never happened. */}
                            {c.lastMessageSenderId && (
                              <span className="text-[10px] text-muted-foreground shrink-0">
                                {formatTime(c.lastMessageAt)}
                              </span>
                            )}
                          </div>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {/* Reserve space so the last conversation clears the floating mobile
                nav (list view only — the nav is hidden once a thread opens). A
                real element, not padding: this is a flex-col scroll container and
                iOS drops a scroller's own padding-bottom. */}
            <div className="md:hidden shrink-0 h-[var(--mobile-nav-clearance)]" aria-hidden />
          </div>
        </aside>

        {/* Active thread. On mobile it becomes a fixed overlay sized to the
            visual viewport (see mobileImmersive above) so header/composer stay
            pinned and only the messages scroll. */}
        <section
          className={`flex-col min-h-0 ${showDetail ? "flex flex-1" : "hidden md:flex"}${
            mobileImmersive ? " fixed left-0 right-0 top-0 z-50 bg-background" : ""
          }`}
          style={
            mobileImmersive
              ? {
                  height: viewport?.height ?? "var(--app-vh)",
                  transform: viewport ? `translateY(${viewport.top}px)` : undefined,
                }
              : undefined
          }
        >
          {isAskOlio ? (
            <>
              <header className="px-4 pb-3 pt-[calc(env(safe-area-inset-top)+0.75rem)] md:pt-3 border-b border-border flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => setActiveId(null)}
                  aria-label="Back to conversations"
                  className="md:hidden -ml-1 mr-0.5 p-1 rounded-lg text-muted-foreground hover:bg-muted transition"
                >
                  <ChevronLeft size={18} />
                </button>
                <div className="w-7 h-7 rounded-full bg-foreground text-background flex items-center justify-center shrink-0">
                  <Sparkles size={14} />
                </div>
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold text-foreground leading-tight">Ask Olio</h2>
                  <p className="text-[11px] text-muted-foreground leading-tight">
                    AI property assistant
                  </p>
                </div>
              </header>
              <div className="flex-1 min-h-0 flex flex-col">
                <AskOlioContent variant="inline" />
              </div>
            </>
          ) : !activeConv ? (
            <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-8 text-center">
              <MessageSquare size={24} className="mb-2 opacity-60" />
              <p className="text-sm max-w-xs">
                {conversations.length === 0
                  ? isTenantView
                    ? "Once your landlord adds you to a property, your chat with them will appear here."
                    : "A chat appears here for each of your active tenants once they've signed up."
                  : "Pick a conversation on the left to start reading."}
              </p>
            </div>
          ) : (
            <>
              <header className="px-4 pb-3 pt-[calc(env(safe-area-inset-top)+0.75rem)] md:pt-3 border-b border-border flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setActiveId(null)}
                  aria-label="Back to conversations"
                  className="md:hidden -ml-1 p-1 rounded-lg text-muted-foreground hover:bg-muted transition"
                >
                  <ChevronLeft size={18} />
                </button>
                <div className="w-7 h-7 rounded-full bg-muted text-foreground border border-border flex items-center justify-center shrink-0 text-[11px] font-semibold uppercase">
                  {initialsFor(activeConv.counterpartName)}
                </div>
                <h2 className="text-sm font-semibold text-foreground">
                  {activeConv.counterpartName}
                </h2>
              </header>
              <div
                ref={scrollRef}
                data-chat-scroll
                className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 py-4 bg-background"
              >
                {/* Cap the conversation to a centered reading column so bubbles
                    don't stretch across a wide full-height desktop pane. */}
                <div className="mx-auto w-full max-w-2xl space-y-3">
                  {msgsLoading ? (
                    <div className="flex items-center justify-center py-10 text-muted-foreground">
                      <Loader2 size={18} className="animate-spin" />
                    </div>
                  ) : messages.length === 0 ? (
                    <div className="text-center text-sm text-muted-foreground py-10">
                      Say hello — they'll get a push notification.
                    </div>
                  ) : (
                    messages.map((m) => {
                      const mine = m.senderId === firebaseUser?.uid;
                      return (
                        <div
                          key={m.id}
                          className={`flex ${mine ? "justify-end" : "justify-start"}`}
                        >
                          <div
                            className={`max-w-[75%] rounded-2xl px-3.5 py-2 text-sm ${
                              mine
                                ? "bg-foreground text-background rounded-br-md"
                                : "bg-card border border-border text-foreground rounded-bl-md"
                            }`}
                          >
                            <p className="whitespace-pre-wrap break-words">{m.text}</p>
                            <p
                              className={`text-[10px] mt-1 ${
                                mine ? "text-background/60" : "text-muted-foreground"
                              }`}
                            >
                              {formatTime(m.createdAt)}
                            </p>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
              <footer className="border-t border-border p-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] md:pb-3 bg-card">
                <div className="mx-auto w-full max-w-2xl flex items-end gap-2">
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void handleSend();
                      }
                    }}
                    onFocus={() => {
                      // The keyboard opening shrinks the viewport; keep the most
                      // recent message in view once it has animated in.
                      window.setTimeout(() => {
                        const el = scrollRef.current;
                        if (el) el.scrollTop = el.scrollHeight;
                      }, 250);
                    }}
                    aria-label="Type a message"
                    placeholder={rateLimited ? "Sending too fast — hold on…" : "Type a message…"}
                    rows={1}
                    className="flex-1 px-3 py-2 rounded-lg border border-border bg-background text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 resize-none min-h-[40px] max-h-32"
                  />
                  <button
                    type="button"
                    onClick={handleSend}
                    disabled={!draft.trim() || sending || rateLimited}
                    className="px-3 py-2 rounded-lg bg-foreground text-background text-sm font-semibold hover:opacity-90 transition disabled:opacity-40 inline-flex items-center gap-1.5"
                  >
                    {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                    Send
                  </button>
                </div>
              </footer>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
