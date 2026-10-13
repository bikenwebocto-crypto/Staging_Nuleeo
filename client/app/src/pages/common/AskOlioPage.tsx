import { useState, useRef, useEffect } from "react";
import { Sparkles, User, ArrowRight, AlertCircle } from "lucide-react";
import { apiRequest, parseApiError } from "@ui/lib/queryClient";
import { PricingModal } from "@ui/components/common/PricingModal";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
}

export default function AskOlioPage() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [isTyping, setIsTyping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPricingOpen, setIsPricingOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isTyping]);

  const handleSend = async (text?: string) => {
    const msgText = text || input.trim();
    if (!msgText || isTyping) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: "user",
      content: msgText,
      timestamp: new Date(),
    };

    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setInput("");
    setIsTyping(true);
    setError(null);

    try {
      const res = await apiRequest("POST", "/api/ask", {
        messages: nextMessages.map((m) => ({ role: m.role, content: m.content })),
      });
      const data = (await res.json()) as { message: string };
      setMessages((prev) => [
        ...prev,
        {
          id: (Date.now() + 1).toString(),
          role: "assistant",
          content: data.message,
          timestamp: new Date(),
        },
      ]);
    } catch (err) {
      const raw = err instanceof Error ? err.message : "Something went wrong";
      // Server returns 402 when the caller's plan doesn't grant askOlio.access.
      // Surface the pricing modal instead of a raw error toast.
      if (raw.startsWith("402")) {
        setIsPricingOpen(true);
        setMessages((prev) => prev.slice(0, -1));
      } else {
        // parseApiError peels the "${status}: ${body}" envelope so the user
        // sees the server's `error` field (e.g. "Daily AskOlio quota reached.")
        // instead of "429: {"error":"...","retryAfterSeconds":86400}".
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
      <div className="flex flex-col h-full min-h-[calc(100vh-120px)]">
        {/* Chat Area */}
        <div className="flex-1 overflow-y-auto px-4 py-6 space-y-4 pb-32">
          {messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center pt-20">
              <div className="bg-foreground text-background p-3 rounded-2xl mb-4">
                <Sparkles size={28} />
              </div>
              <h2 className="text-2xl font-bold text-foreground mb-2">Ask Olio</h2>
              <p className="text-sm text-muted-foreground max-w-[240px] mb-8">
                Ask me anything about your properties, tenants, or market trends.
              </p>

              <div className="flex flex-wrap justify-center gap-2">
                {suggestions.map((s) => (
                  <button
                    key={s}
                    onClick={() => handleSend(s)}
                    className="text-xs bg-card border border-border px-4 py-2 rounded-full text-muted-foreground font-medium hover:border-foreground hover:text-foreground transition"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((message) => (
              <div
                key={message.id}
                className={`flex items-end gap-2 ${message.role === "user" ? "justify-end" : "justify-start"}`}
              >
                {message.role === "assistant" && (
                  <div className="w-7 h-7 rounded-full bg-foreground flex items-center justify-center flex-shrink-0 mb-1">
                    <Sparkles size={14} className="text-background" />
                  </div>
                )}

                <div
                  className={`max-w-[80%] p-3.5 rounded-2xl text-sm leading-relaxed shadow-sm ${
                    message.role === "user"
                      ? "bg-foreground text-background rounded-br-none"
                      : "bg-card text-foreground rounded-bl-none border border-border"
                  }`}
                >
                  {message.content}
                </div>

                {message.role === "user" && (
                  <div className="w-7 h-7 rounded-full bg-secondary flex items-center justify-center flex-shrink-0 mb-1">
                    <User size={14} className="text-muted-foreground" />
                  </div>
                )}
              </div>
            ))
          )}

          {isTyping && (
            <div className="flex justify-start items-end gap-2">
              <div className="w-7 h-7 rounded-full bg-foreground flex items-center justify-center flex-shrink-0 mb-1">
                <Sparkles size={14} className="text-background" />
              </div>
              <div className="bg-card border border-border px-4 py-3 rounded-2xl rounded-bl-none shadow-sm flex gap-1.5 items-center">
                <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce [animation-delay:-0.3s]"></span>
                <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce [animation-delay:-0.15s]"></span>
                <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce"></span>
              </div>
            </div>
          )}

          {error && (
            <div className="flex justify-center">
              <div className="bg-destructive text-destructive-foreground text-xs font-medium px-4 py-2 rounded-full flex items-center gap-1.5 shadow-sm">
                <AlertCircle size={14} />
                {error}
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input Area - fixed at bottom */}
        <div className="sticky bottom-0 bg-card p-4 border-t border-border z-20">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSend();
            }}
            className="relative flex items-center gap-2 max-w-2xl mx-auto w-full"
          >
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              aria-label="Ask Olio"
              placeholder="Ask Olio..."
              className="flex-1 bg-secondary border-none rounded-2xl px-5 py-3.5 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-foreground/10 transition font-medium"
              autoFocus
            />
            <button
              type="submit"
              disabled={!input.trim() || isTyping}
              aria-label="Send message"
              className="w-12 h-12 bg-primary text-primary-foreground rounded-2xl flex items-center justify-center hover:bg-primary/90 transition disabled:opacity-50 shadow-lg shadow-foreground/10"
            >
              <ArrowRight size={20} />
            </button>
          </form>
        </div>
      </div>
    </>
  );
}
