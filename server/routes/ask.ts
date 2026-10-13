// Ask Olio — chat completion proxy with tool calling. Two-tier shape:
//
//   1. A lightweight portfolio snapshot is injected as a system message
//      so simple questions ("how many properties?") answer in one
//      cheap completion with no extra fetches.
//
//   2. The model is given function tools (askOlioTools) it can invoke
//      on demand for deep questions ("what's the yield on 123 Main St",
//      "show me last month's expenses"). The server runs the tool,
//      feeds the result back, and the model produces the final answer.
//
// Net cost scales with the question, not with portfolio size. Owner-
// plan gated on the ACTIVE PORTFOLIO's plan because every call burns
// paid OpenAI tokens; a granted contact assisting on a Pro portfolio
// gets access without buying their own subscription.

import type { Express, RequestHandler } from "express";
import { requireAuth } from "../auth";
import { requireFeature } from "../services/featureFlags";
import { openai, ASK_OLIO_MODEL, ASK_OLIO_SYSTEM_PROMPT, ASK_MAX_HISTORY } from "../openai";
import { errMsg } from "../services/errMsg";
import { checkAndIncrement as rateLimit } from "../services/rateLimit";
import { resolveOwnerScope, authorizePortfolioRead } from "../services/ownerScope";
import {
  askOlioTools,
  buildAskOlioSnapshot,
  runAskOlioTool,
  type AskOlioAccess,
} from "../services/askOlioContext";
import type { OwnerPlanPrivilegeKey } from "../../shared/firestore-schema";
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions";

export interface AskDeps {
  requireActivePortfolioPlanPrivilege: (p: OwnerPlanPrivilegeKey) => RequestHandler;
}

// Hard cap on tool-call rounds per user message. Three rounds covers
// "look up property X then list its transactions" patterns; anything
// more and we're paying for the model to flail. Without this a buggy
// or malicious tool flow could rack up unbounded billable completions
// on a single user turn.
const MAX_TOOL_ROUNDS = 3;

export function registerAskRoutes(
  app: Express,
  { requireActivePortfolioPlanPrivilege }: AskDeps,
): void {
  app.post(
    "/api/ask",
    requireAuth,
    requireActivePortfolioPlanPrivilege("askOlio.access"),
    requireFeature("askOlio"),
    async (req, res) => {
      // Per-user daily cap on OpenAI calls. Owner-plan gating already
      // restricts who CAN call; this caps how much a single user can
      // burn in 24h. 50/day is generous for normal use, tight enough
      // to bound budget exposure if a UI bug puts the page in a
      // request loop.
      const { uid } = req.user!;
      const limit = await rateLimit(`ask:${uid}`, 50, 24 * 60 * 60);
      if (!limit.allowed) {
        res.set("Retry-After", String(limit.retryAfterSeconds));
        return res.status(429).json({
          error: "Daily AskOlio quota reached. Try again tomorrow.",
          retryAfterSeconds: limit.retryAfterSeconds,
        });
      }
      const body = req.body as { messages?: unknown } | undefined;
      const raw = Array.isArray(body?.messages) ? body!.messages : [];
      // Per-message length cap. Without this, the 50/day rate limit
      // lets an attacker amplify OpenAI token spend by ~50× by
      // stuffing each message with megabytes of text. 4kB per message
      // × 20-message history = 80kB max input.
      const MAX_MESSAGE_CHARS = 4000;
      const userMessages = raw
        .filter(
          (m): m is { role: "user" | "assistant"; content: string } =>
            !!m &&
            typeof m === "object" &&
            (m as { role?: unknown }).role !== "system" &&
            ((m as { role?: unknown }).role === "user" ||
              (m as { role?: unknown }).role === "assistant") &&
            typeof (m as { content?: unknown }).content === "string" &&
            (m as { content: string }).content.trim().length > 0,
        )
        .slice(-ASK_MAX_HISTORY)
        .map((m) => ({ ...m, content: m.content.slice(0, MAX_MESSAGE_CHARS) }));

      if (userMessages.length === 0) {
        return res.status(400).json({ error: "messages must be a non-empty array" });
      }

      // Resolve active portfolio so the snapshot + tool fetches scope
      // to the owner the caller is acting on behalf of. Middleware
      // above already enforced read access; this is just to get the id.
      const scope = await resolveOwnerScope(req);
      if (!scope.ok) {
        return res.status(scope.status).json({ error: scope.error });
      }

      // The plan gate above proves the caller may USE AskOlio on this
      // portfolio; it does NOT enforce the per-role privilege matrix. A granted
      // contact (legal / financial / …) must not read past their role through
      // the assistant — so resolve their per-resource access and pass it to the
      // snapshot (redaction) and the tools (refusal). resolveOwnerScope marks
      // self, who gets everything.
      let access: AskOlioAccess;
      if (scope.isSelf) {
        access = {
          isSelf: true,
          property: true,
          tenant: true,
          agreement: true,
          finance: true,
          portfolio: true,
        };
      } else {
        const [property, tenant, agreement, finance, portfolio] = await Promise.all([
          authorizePortfolioRead(uid, scope, "property.view"),
          authorizePortfolioRead(uid, scope, "tenant.view"),
          authorizePortfolioRead(uid, scope, "agreement.view"),
          authorizePortfolioRead(uid, scope, "finance.viewHistory"),
          authorizePortfolioRead(uid, scope, "analytics.viewPortfolio"),
        ]);
        access = {
          isSelf: false,
          property: property.ok,
          tenant: tenant.ok,
          agreement: agreement.ok,
          finance: finance.ok,
          portfolio: portfolio.ok,
        };
      }

      const portfolioSnapshot = await buildAskOlioSnapshot(scope.ownerId, access);

      const messages: ChatCompletionMessageParam[] = [
        { role: "system", content: ASK_OLIO_SYSTEM_PROMPT },
        { role: "system", content: portfolioSnapshot },
        ...userMessages,
      ];

      try {
        // Tool-call loop. Most turns exit on the first iteration (no
        // tool call → finish). When the model emits tool_calls, we run
        // them, push the results back as `role: "tool"` messages, and
        // re-prompt up to MAX_TOOL_ROUNDS times.
        for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
          const completion = await openai().chat.completions.create({
            model: ASK_OLIO_MODEL,
            messages,
            tools: askOlioTools,
            // Final round: force the model to commit to an answer
            // instead of asking for more tools we won't honor.
            tool_choice: round === MAX_TOOL_ROUNDS ? "none" : "auto",
            // Budget guard: without max_tokens a runaway model that
            // ignores the prompt and produces 128k-token responses
            // would multiply worst-case spend ~50×. 800 tokens
            // (~600 words) is plenty for the conversational shape.
            max_tokens: 800,
          });
          const choice = completion.choices[0];
          const msg = choice?.message;
          if (!msg) {
            return res.status(502).json({ error: "Empty response from model" });
          }

          const toolCalls = (msg.tool_calls ?? []) as ChatCompletionMessageToolCall[];
          if (toolCalls.length === 0) {
            return res.json({ message: (msg.content ?? "").trim() });
          }

          // Push the assistant's tool-call message back into history
          // before running tools — OpenAI requires the tool result
          // messages to follow the assistant message that requested
          // them, in order.
          messages.push({
            role: "assistant",
            content: msg.content ?? "",
            tool_calls: toolCalls,
          });

          for (const tc of toolCalls) {
            if (tc.type !== "function") continue;
            let parsedArgs: Record<string, unknown> = {};
            try {
              parsedArgs = JSON.parse(tc.function.arguments || "{}");
            } catch {
              // Model emitted invalid JSON — send back an error string
              // rather than crashing the round; the model usually
              // recovers on the next turn.
              parsedArgs = {};
            }
            const result = await runAskOlioTool(
              scope.ownerId,
              tc.function.name,
              parsedArgs,
              access,
            );
            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: result,
            });
          }
        }
        // Shouldn't reach here — the round === MAX guard forces a
        // tool-free completion above. If we do, surface a clear error.
        return res.status(502).json({ error: "Tool-call loop did not converge" });
      } catch (err: unknown) {
        const e = err as { status?: number } | undefined;
        const status = e?.status === 401 ? 500 : (e?.status ?? 500);
        res.status(status).json({ error: errMsg(err, "OpenAI request failed") });
      }
    },
  );
}
