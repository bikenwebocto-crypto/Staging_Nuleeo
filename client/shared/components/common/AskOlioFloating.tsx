import { useState, useRef, useEffect } from "react";
import { X, Sparkles, ArrowRight } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { apiRequest, parseApiError } from "@ui/lib/queryClient";
import { PricingModal } from "@ui/components/common/PricingModal";

export function AskOlioFloating() {
  const [isOpen, setIsOpen] = useState(false);
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
    if (isOpen) {
      scrollToBottom();
    }
  }, [chatMessages, isTyping, isOpen]);

  useEffect(() => {
    const handleOpenChat = () => setIsOpen(true);
    window.addEventListener("open-olio-chat", handleOpenChat);
    return () => window.removeEventListener("open-olio-chat", handleOpenChat);
  }, []);

  const handleChatSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const msg = chatInput.trim();
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
      <div className="fixed bottom-8 right-8 z-50 hidden md:flex flex-col items-end gap-4 pointer-events-auto">
        <AnimatePresence>
          {isOpen && (
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              transition={{ duration: 0.2 }}
              className="bg-card rounded-2xl shadow-2xl border border-border w-[380px] h-[600px] flex flex-col overflow-hidden"
            >
              {/* Header */}
              <div className="px-6 py-4 border-b border-border flex items-center justify-between bg-card">
                <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
                  <div className="bg-foreground text-background p-1.5 rounded-lg">
                    <Sparkles size={16} />
                  </div>
                  Ask Olio
                </h2>
                <button
                  onClick={() => setIsOpen(false)}
                  aria-label="Close chat"
                  className="w-8 h-8 rounded-full bg-background flex items-center justify-center text-muted-foreground/70 hover:bg-secondary transition"
                >
                  <X size={18} />
                </button>
              </div>

              {/* Chat Area */}
              <div className="flex-1 overflow-y-auto px-5 py-5 space-y-4 custom-scrollbar bg-background">
                {chatMessages.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-center opacity-60">
                    <h3 className="font-bold text-foreground mb-2">How can I help you today?</h3>
                    <p className="text-sm text-muted-foreground max-w-[200px] mb-6">
                      Ask me anything about your properties, tenants, or market trends.
                    </p>

                    <div className="flex flex-wrap justify-center gap-2">
                      {suggestions.map((s) => (
                        <button
                          key={s}
                          onClick={() => setChatInput(s)}
                          className="text-xs bg-card border border-border px-3 py-1.5 rounded-full text-muted-foreground font-medium hover:border-foreground hover:text-foreground transition"
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  chatMessages.map((msg, idx) => (
                    <div
                      key={idx}
                      className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                    >
                      <div
                        className={`max-w-[85%] p-3 rounded-2xl text-sm leading-relaxed shadow-sm ${
                          msg.role === "user"
                            ? "bg-foreground text-background rounded-br-none"
                            : "bg-card text-foreground border border-border rounded-bl-none"
                        }`}
                      >
                        {msg.text}
                      </div>
                    </div>
                  ))
                )}

                {isTyping && (
                  <div className="flex justify-start">
                    <div className="bg-card border border-border px-4 py-3 rounded-2xl rounded-bl-none shadow-sm flex gap-1.5 items-center">
                      <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce [animation-delay:-0.3s]"></span>
                      <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce [animation-delay:-0.15s]"></span>
                      <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce"></span>
                    </div>
                  </div>
                )}

                {error && (
                  <div className="flex justify-center">
                    <div className="bg-destructive/10 text-destructive text-xs px-4 py-2 rounded-full">
                      {error}
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Input Area */}
              <div className="p-4 bg-card border-t border-border">
                <form onSubmit={handleChatSubmit} className="relative flex items-center gap-2">
                  <input
                    type="text"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    aria-label="Ask Olio"
                    placeholder="Ask Olio..."
                    className="flex-1 bg-background border-none rounded-xl px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-foreground/10 transition font-medium"
                    autoFocus={isOpen}
                  />
                  <button
                    type="submit"
                    disabled={!chatInput.trim() || isTyping}
                    aria-label="Send message"
                    className="w-10 h-10 bg-foreground text-background rounded-xl flex items-center justify-center hover:bg-foreground/90 transition disabled:opacity-50 shadow-lg shadow-foreground/20"
                  >
                    <ArrowRight size={18} />
                  </button>
                </form>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <button
          onClick={() => setIsOpen(!isOpen)}
          aria-label={isOpen ? "Close Ask Olio" : "Open Ask Olio"}
          className={`w-14 h-14 rounded-full shadow-xl flex items-center justify-center transition-all duration-300 ${
            isOpen
              ? "bg-secondary text-foreground hover:bg-secondary rotate-90"
              : "bg-foreground text-background hover:bg-foreground/90 hover:scale-110"
          }`}
        >
          {isOpen ? (
            <X size={24} />
          ) : (
            <svg
              width="24"
              height="24"
              viewBox="0 0 511.996 511.996"
              fill="currentColor"
              aria-hidden="true"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path d="m174.62 347.588c-54.464-53.489-75.817-135.466-55.51-208.81-119.959 45.513-158.014 197.945-73.8 294.74l-23.69 68.19 76.17-26.46c83.833 46.035 195.081 15.969 244.26-65.17-62.292 4.449-123.359-18.201-167.43-62.49z" />
              <path d="m471.68 310.698c96.395-119.583 8.786-301.126-144.922-300.408-102.909-.43-185.838 85.422-185.158 185.159 0 102.099 83.07 185.16 185.16 185.16 30.534.109 60.199-7.533 87.29-21.72l76.17 26.46-23.69-68.19zm-231.81-48.63c-6.986-2.662-21.045-8.014-28.03-10.67 8.174-21.482 50.137-131.661 59.2-155.46l26.92-.03 58.69 155.53c-6.997 2.637-21.076 7.949-28.07 10.59-1.284-3.399-8.567-22.713-10.01-26.54h-68.58c-2.885 7.614-7.233 18.98-10.12 26.58zm188.38.29h-30v-80.97h30zm0-116.569h-30v-30h30z" />
              <path d="m284.44 145.048-23.02 60.441h45.83z" />
            </svg>
          )}
        </button>
      </div>
    </>
  );
}
