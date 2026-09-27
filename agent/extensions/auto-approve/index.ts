/**
 * Auto-approve — LLM-verified approval for bash commands.
 *
 * While enabled, every `bash` command the agent requests is verified by the
 * selected LLM with a minimal prompt before it runs:
 *   - the command itself, and
 *   - the agent's own message explaining why it is needed (the "comment" —
 *     the assistant message that immediately precedes the tool call; falls back
 *     to its thinking text when the model shows no visible text).
 *
 * The verifier answers with exactly one line:
 *   APPROVE
 *   DENY: <short reason>
 *
 * Fail-closed: on verification error, timeout, or user abort the command is
 * blocked. Approvals are silent; denials go back to the agent as the tool
 * result so it can adjust.
 *
 * Commands:
 *   /approve                show status
 *   /approve on|off         toggle verification
 *   /approve model          clear verifier-model override (use selected model)
 *   /approve model <ref>    pin a verifier model (provider/id or substring)
 *   /approve test <cmd>     run the "safe" verifier once and report the verdict
 *   /approve test-ro <cmd>  run the "read-only" verifier once and report it
 *
 * `verifyCommand()` / `withLoader()` are exported so other extensions
 * (e.g. ro-mode) can reuse the verifier. mode: "read-only" runs the same
 * check with one condition added: the command must not modify the system.
 */

import type { AssistantMessage, Model, UserMessage } from "@earendil-works/pi-ai";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";

export type VerifyMode = "safe" | "read-only";

export interface Verdict {
  approved: boolean;
  reason: string;
}

export interface VerifyParams {
  command: string;
  /** The agent's message explaining why the command is needed. */
  comment?: string;
  mode: VerifyMode;
  model: Model<any>;
  modelRegistry: ModelRegistry;
  signal?: AbortSignal;
}

/**
 * Base auto-approve check (normal mode): is the command ok to execute under
 * the condition the agent asked for — its stated reason — without blowing up
 * the system?
 */
const BASE_PROMPT = `You verify a shell command requested by a coding agent. You receive the command and the condition the agent asked for — the reason it stated for the command.

Reply with exactly one line:
- "APPROVE" if the command is ok to execute under that condition: it matches the stated reason and is sane.
- "DENY: <short reason>" if the command does not match the reason, is destructive or irreversible, could blow up the whole system, or is likely to hang or flood output.
- If the agent gave no reason ("(none given)"), judge the command on its own merits: approve if it is sane and not destructive.

Be decisive. No other text.`;

/**
 * READ-ONLY mode = the same base check, plus this additional condition.
 */
const READ_ONLY_CONDITION = `ADDITIONAL CONDITION (read-only mode): the command must not modify the system in any way — no creating, overwriting, deleting, renaming, or moving files or directories; no package installs/uninstalls/updates; no git commands that change state (add, commit, checkout, reset, push, pull, ...); no package-manager mutations; no service/daemon or environment changes; no downloads or uploads with side effects. Reading, listing, searching, querying, status checks, and piping into read-only tools are fine.`;

function systemPromptFor(mode: VerifyMode): string {
  return mode === "read-only" ? `${BASE_PROMPT}\n\n${READ_ONLY_CONDITION}` : BASE_PROMPT;
}

const MAX_COMMAND_CHARS = 4000;
const MAX_COMMENT_CHARS = 1500;
/** "DENY: <short reason>" fits comfortably in this budget. */
const VERIFIER_MAX_TOKENS = 48;
/** Reasoning models burn part of the budget on their reasoning output, so the
 * one-line verdict needs a larger ceiling to still fit. */
const REASONING_VERIFIER_MAX_TOKENS = 1024;

function verificationMaxTokens(model: Model<any>): number {
  return model.reasoning ? REASONING_VERIFIER_MAX_TOKENS : VERIFIER_MAX_TOKENS;
}

/**
 * Providers whose backend rejected `temperature` (e.g. "Unsupported
 * parameter: temperature" on the ChatGPT/Codex backend). Detected once per
 * session via a failed call + retry; subsequent calls omit the parameter.
 */
const temperatureUnsupported = new Set<string>();

/**
 * Extra request body params for the verification call, to keep it fast.
 * Qwen3 models on vLLM think by default, which would eat the whole
 * maxTokens budget before the one-line verdict; disable thinking for those.
 * Override with PI_APPROVE_SAMPLING_PARAMS (JSON object).
 */
function verificationSamplingParams(model: Model<any>): Record<string, unknown> | undefined {
  const fromEnv = process.env.PI_APPROVE_SAMPLING_PARAMS;
  if (fromEnv) {
    try {
      const parsed: unknown = JSON.parse(fromEnv);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // invalid JSON — fall through
    }
  }
  if (/qwen/i.test(model.id)) {
    return { chat_template_kwargs: { enable_thinking: false } };
  }
  return undefined;
}

function verificationTimeoutMs(): number {
  const ms = Number(process.env.PI_APPROVE_TIMEOUT_MS);
  return Number.isFinite(ms) && ms > 0 ? ms : 20_000;
}

function buildPrompt(mode: VerifyMode, command: string, comment: string | undefined) {
  const cmd =
    command.length > MAX_COMMAND_CHARS
      ? `${command.slice(0, MAX_COMMAND_CHARS)}\n...(truncated)`
      : command;
  const trimmed = comment?.trim();
  const reason = !trimmed
    ? "(none given)"
    : trimmed.length > MAX_COMMENT_CHARS
      ? `...${trimmed.slice(-MAX_COMMENT_CHARS)}`
      : trimmed;
  // Some calls (notably the first tool call in a session) have no preceding
  // agent text, so the reason is often absent — make that explicit.
  const reasonLine = trimmed
    ? `Reason: ${reason}`
    : `Reason: ${reason} (agent gave no explicit reason — judge the command on its own merits)`;
  return {
    systemPrompt: systemPromptFor(mode),
    user: `${reasonLine}\n\nCommand:\n${cmd}`,
  };
}

function parseVerdict(text: string): Verdict {
  const line =
    text
      .trim()
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  const upper = line.toUpperCase();
  if (upper.startsWith("DENY")) {
    const reason = line.slice(line.toUpperCase().indexOf("DENY") + 4).replace(/^[\s:;\-—]+/, "").trim();
    return { approved: false, reason: reason || "verifier denied" };
  }
  if (upper.startsWith("APPROVE")) {
    return { approved: true, reason: "approved" };
  }
  return { approved: false, reason: `unrecognized verifier reply: ${line.slice(0, 120)}` };
}

/**
 * Verify a command with the given model. Never rejects: errors, timeouts, and
 * aborts resolve to a fail-closed (approved: false) verdict.
 */
export async function verifyCommand(p: VerifyParams): Promise<Verdict> {
  const timeoutMs = verificationTimeoutMs();
  const { systemPrompt, user } = buildPrompt(p.mode, p.command, p.comment);
  const userMessage: UserMessage = {
    role: "user",
    content: [{ type: "text", text: user }],
    timestamp: Date.now(),
  };

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onOuterAbort = () => controller.abort();
  p.signal?.addEventListener("abort", onOuterAbort, { once: true });

  try {
    // temperature: 0 keeps verdicts stable across repeated calls. Some
    // backends (e.g. ChatGPT/Codex) reject the parameter entirely; that is
    // detected once via a failed call + retry, then remembered.
    const completeOnce = (omitTemperature: boolean) =>
      p.modelRegistry.complete(p.model, { systemPrompt, messages: [userMessage] }, {
        signal: controller.signal,
        maxTokens: verificationMaxTokens(p.model),
        ...(omitTemperature || temperatureUnsupported.has(p.model.provider) ? {} : { temperature: 0 }),
        samplingParams: verificationSamplingParams(p.model),
      });
    let res: AssistantMessage = await completeOnce(false);
    if (res.stopReason === "error" && /temperature/i.test(res.errorMessage ?? "") && !temperatureUnsupported.has(p.model.provider)) {
      temperatureUnsupported.add(p.model.provider);
      res = await completeOnce(true);
    }
    if (res.stopReason === "aborted") {
      if (timedOut) return { approved: false, reason: `verification timed out after ${timeoutMs}ms` };
      return { approved: false, reason: "verification cancelled" };
    }
    // complete() resolves — rather than throwing — on provider errors;
    // surface the real message instead of reporting "no text".
    if (res.stopReason === "error") {
      return { approved: false, reason: `verification failed: ${(res.errorMessage ?? "unknown provider error").slice(0, 160)}` };
    }
    const text = res.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();
    if (!text) {
      // A reasoning verifier can use the whole budget on thinking and leave the
      // verdict in the thinking block. Take it from there before failing closed.
      const thinking = res.content
        .filter((c): c is { type: "thinking"; thinking: string } => c.type === "thinking")
        .map((c) => c.thinking ?? "")
        .join("\n");
      const lines = thinking.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
      const verdictLine = [...lines].reverse().find((l) => /^(APPROVE|DENY)\b/i.test(l));
      if (verdictLine) return parseVerdict(verdictLine);
      return { approved: false, reason: "verifier returned no text" };
    }
    return parseVerdict(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (timedOut) return { approved: false, reason: `verification timed out after ${timeoutMs}ms` };
    if (controller.signal.aborted) return { approved: false, reason: "verification cancelled" };
    return { approved: false, reason: `verification failed: ${message.slice(0, 160)}` };
  } finally {
    clearTimeout(timer);
    p.signal?.removeEventListener("abort", onOuterAbort);
  }
}

/**
 * Run `fn`, showing a spinner while it works when a TUI is available.
 * Returns null when the user aborts the spinner (or the UI cannot be shown
 * and the work fails to start).
 */
export async function withLoader<T>(
  ctx: ExtensionContext,
  label: string,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T | null> {
  if (ctx.hasUI && ctx.mode === "tui") {
    try {
      return await ctx.ui.custom<T | null>((tui, theme, _kb, done) => {
        const loader = new BorderedLoader(tui, theme, label);
        loader.onAbort = () => done(null);
        fn(loader.signal)
          .then((r) => done(r))
          .catch(() => done(null));
        return loader;
      });
    } catch {
      return null;
    }
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  ctx.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await fn(controller.signal);
  } finally {
    ctx.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Extract the agent's latest message text ("comment") — the assistant message
 * that precedes the requested command — so the verifier can check why it is
 * needed.
 */
export function extractComment(sessionManager: ExtensionContext["sessionManager"]): string | undefined {
  const branch = sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i] as {
      type?: string;
      message?: { role?: string; content?: unknown };
    };
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (!msg || msg.role !== "assistant") continue;
    if (!Array.isArray(msg.content)) continue;
    const blocks = msg.content.filter(
      (c): c is { type: string; text?: string; thinking?: string } => Boolean(c && typeof c === "object"),
    );
    const text = blocks
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n")
      .trim();
    if (text) return text;
    // Reasoning models (gpt-5.x/6.x on the Codex backend, Qwen on vLLM, ...) keep
    // the rationale in thinking blocks and emit no visible text before a tool
    // call. Use that as the stated reason instead of "(none given)".
    const thinking = blocks
      .filter((c) => c.type === "thinking")
      .map((c) => c.thinking ?? "")
      .join("\n")
      .trim();
    return thinking || undefined;
  }
  return undefined;
}

export default function (pi: ExtensionAPI) {
  let enabled = true;
  let verifyModel: Model<any> | null = null; // null → use the selected model

  const syncStatus = (ctx: ExtensionContext) => {
    const model = verifyModel ?? ctx.model;
    ctx.ui.setStatus(
      "auto-approve",
      `approve: ${enabled ? "on" : "off"}${model ? ` (${model.provider}/${model.id})` : ""}`,
    );
  };

  pi.on("session_start", (_event, ctx) => {
    syncStatus(ctx);
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!enabled || event.toolName !== "bash") return;

    const command = event.input.command ?? "";
    const model = verifyModel ?? ctx.model;
    if (!model) return; // no model to verify with — nothing can gate this

    const comment = extractComment(ctx.sessionManager);
    const verdict = await withLoader(
      ctx,
      `Verifying command via ${model.provider}/${model.id}…`,
      (signal) => verifyCommand({ command, comment, mode: "safe", model, modelRegistry: ctx.modelRegistry, signal }),
    );
    if (!verdict) return { block: true, reason: "Auto-approve: verification cancelled." };
    if (!verdict.approved) return { block: true, reason: `Auto-approve: ${verdict.reason}` };
  });

  pi.registerCommand("approve", {
    description: "LLM auto-approve for bash: /approve [on|off] | /approve model [ref] | /approve test|test-ro <command>",
    handler: async (args, ctx) => {
      const a = args.trim().split(/\s+/).filter(Boolean);
      if (a.length === 0 || a[0] === "status") {
        const model = verifyModel ?? ctx.model;
        ctx.ui.notify(
          `Auto-approve: ${enabled ? "ON" : "OFF"} · verifier: ${model ? `${model.provider}/${model.id}` : "none"}`,
          "info",
        );
        return;
      }
      if (a[0] === "on" || a[0] === "off") {
        enabled = a[0] === "on";
        syncStatus(ctx);
        ctx.ui.notify(
          enabled
            ? "Auto-approve ON: every bash command is verified by the LLM before running"
            : "Auto-approve OFF",
          enabled ? "warning" : "info",
        );
        return;
      }
      if (a[0] === "test" || a[0] === "test-ro") {
        // Debug helper: run the verifier once and report the verdict.
        //   /approve test <command>    — "safe" mode
        //   /approve test-ro <command> — "read-only" mode (ro-mode check)
        const command = a.slice(1).join(" ").trim();
        const model = verifyModel ?? ctx.model;
        if (!command) {
          ctx.ui.notify("Usage: /approve test <command> | /approve test-ro <command>", "info");
          return;
        }
        if (!model) {
          ctx.ui.notify("No model available for verification", "error");
          return;
        }
        const mode: VerifyMode = a[0] === "test-ro" ? "read-only" : "safe";
        const verdict = await withLoader(
          ctx,
          `Test verification (${mode}) via ${model.provider}/${model.id}…`,
          (signal) =>
            verifyCommand({
              command,
              comment: "(manual test — no agent comment)",
              mode,
              model,
              modelRegistry: ctx.modelRegistry,
              signal,
            }),
        );
        ctx.ui.notify(
          verdict ? `Auto-approve test: ${verdict.approved ? "APPROVE" : `DENY — ${verdict.reason}`}` : "Auto-approve test: cancelled",
          verdict?.approved ? "info" : "warning",
        );
        return;
      }
      if (a[0] === "model") {
        if (a.length === 1) {
          verifyModel = null;
          syncStatus(ctx);
          ctx.ui.notify("Verifier model: using the currently selected model", "info");
          return;
        }
        const ref = a.slice(1).join(" ");
        const all = ctx.modelRegistry.getAll();
        const match =
          all.find((m) => `${m.provider}/${m.id}` === ref) ??
          all.find((m) => m.id === ref || `${m.provider}/${m.id}`.includes(ref));
        if (!match) {
          ctx.ui.notify(`No model matching "${ref}"`, "error");
          return;
        }
        verifyModel = match;
        syncStatus(ctx);
        ctx.ui.notify(`Verifier model set to ${match.provider}/${match.id}`, "info");
        return;
      }
      ctx.ui.notify(
        "Usage: /approve | /approve on|off | /approve model [provider/id] | /approve test|test-ro <command>",
        "info",
      );
    },
  });
}
