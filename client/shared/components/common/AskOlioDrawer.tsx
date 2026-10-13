import { useState, useRef, useEffect } from "react";
import { Send, AlertCircle } from "lucide-react";
import { apiRequest, parseApiError } from "@ui/lib/queryClient";
import { PricingModal } from "@ui/components/common/PricingModal";

/**
 * Standalone chat UI for Ask Olio.
 * Meant to be placed inside a ResponsiveDrawer (or any container).
 *
 * `variant` controls the outer spacing:
 *  - "drawer" (default): negative margins cancel the ResponsiveDrawer's own
 *    padding so the chat goes edge-to-edge.
 *  - "inline": no negative margins — for embedding in a pane that supplies its
 *    own padding (e.g. the Messages page right column).
 */
export function AskOlioContent({
  variant = "drawer",
}: {
  variant?: "drawer" | "inline";
} = {}) {
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<{ role: "user" | "bot"; text: string }[]>([]);
  const [isTyping, setIsTyping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPricingOpen, setIsPricingOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [chatMessages, isTyping]);

  const handleChatSubmit = async (e?: React.FormEvent, text?: string) => {
    e?.preventDefault();
    const msg = text || chatInput.trim();
    if (!msg || isTyping) return;

    const nextMessages = [...chatMessages, { role: "user" as const, text: msg }];
    setChatMessages(nextMessages);
    setChatInput("");
    setIsTyping(true);
    setError(null);

    try {
      const res = await apiRequest("POST", "/api/ask", {
        messages: nextMessages.map((m) => ({
          role: m.role === "bot" ? "assistant" : "user",
          content: m.text,
        })),
      });
      const data = (await res.json()) as { message: string };
      setChatMessages((prev) => [...prev, { role: "bot", text: data.message }]);
    } catch (err) {
      const raw = err instanceof Error ? err.message : "Something went wrong";
      if (raw.startsWith("402")) {
        setIsPricingOpen(true);
        setChatMessages((prev) => prev.slice(0, -1));
      } else {
        // Peel the "${status}: ${body}" envelope so 429 shows "Daily AskOlio
        // quota reached." instead of the raw JSON.
        setError(parseApiError(err, "Something went wrong"));
      }
    } finally {
      setIsTyping(false);
    }
  };

  const suggestions = ["Portfolio performance?", "Rental yield analysis?", "Maintenance status?"];

  return (
    <>
      <PricingModal open={isPricingOpen} onOpenChange={setIsPricingOpen} />
      <div className={`flex flex-col h-full ${variant === "drawer" ? "-mx-5 -mt-2" : ""}`}>
        {/* Messages — same layout/look as the conversation chat. data-chat-scroll
            marks it as an allowed scroll region for the Messages-page touch-lock. */}
        <div
          data-chat-scroll
          className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 py-4 bg-background custom-scrollbar"
        >
          <div className="mx-auto w-full max-w-2xl space-y-3">
            {chatMessages.length === 0 ? (
              <div className="flex flex-col items-center justify-center text-center pt-10">
                <h3 className="font-bold text-foreground mb-2">How can I help you today?</h3>
                <p className="text-sm text-muted-foreground max-w-[220px] mb-6">
                  Ask me anything about your properties, tenants, or market trends.
                </p>

                <div className="flex flex-wrap justify-center gap-2">
                  {suggestions.map((s) => (
                    <button
                      key={s}
                      onClick={() => handleChatSubmit(undefined, s)}
                      className="text-xs bg-card border border-border px-3 py-1.5 rounded-full text-muted-foreground font-medium hover:border-foreground hover:text-foreground transition"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              chatMessages.map((msg, idx) => {
                const mine = msg.role === "user";
                return (
                  <div key={idx} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                    <div
                      className={`max-w-[80%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${
                        mine
                          ? "bg-foreground text-background rounded-br-md"
                          : "bg-card border border-border text-foreground rounded-bl-md"
                      }`}
                    >
                      <p className="whitespace-pre-wrap break-words">{msg.text}</p>
                    </div>
                  </div>
                );
              })
            )}

            {isTyping && (
              <div className="flex justify-start">
                <div className="bg-card border border-border px-4 py-3 rounded-2xl rounded-bl-md flex gap-1.5 items-center">
                  <span className="w-1.5 h-1.5 bg-muted-foreground/50 rounded-full animate-bounce [animation-delay:-0.3s]"></span>
                  <span className="w-1.5 h-1.5 bg-muted-foreground/50 rounded-full animate-bounce [animation-delay:-0.15s]"></span>
                  <span className="w-1.5 h-1.5 bg-muted-foreground/50 rounded-full animate-bounce"></span>
                </div>
              </div>
            )}

            {error && (
              <div className="flex justify-center">
                <div className="bg-destructive/10 text-destructive text-xs font-medium px-4 py-2 rounded-full flex items-center gap-1.5">
                  <AlertCircle size={14} />
                  {error}
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Composer — identical to the conversation chat (bordered input + Send). */}
        <div
          className={`border-t border-border shrink-0 bg-card p-3 ${
            variant === "inline" ? "pb-[calc(env(safe-area-inset-bottom)+0.75rem)] md:pb-3" : ""
          }`}
        >
          <form
            onSubmit={handleChatSubmit}
            className="mx-auto w-full max-w-2xl flex items-end gap-2"
          >
            <input
              type="text"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              aria-label="Ask Olio"
              placeholder="Ask Olio…"
              className="flex-1 px-3 py-2 rounded-lg border border-border bg-background text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 min-h-[40px]"
              autoFocus
            />
            <button
              type="submit"
              disabled={!chatInput.trim() || isTyping}
              className="px-3 py-2 rounded-lg bg-foreground text-background text-sm font-semibold hover:opacity-90 transition disabled:opacity-40 inline-flex items-center gap-1.5"
            >
              <Send size={14} /> Send
            </button>
          </form>
        </div>
      </div>
    </>
  );
}
