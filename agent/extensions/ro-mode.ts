import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * /ro — read-only mode for Pi (toggle).
 *
 * While active:
 *  - All write/edit tool calls are blocked.
 *  - All bash commands prompt for confirmation.
 *  - User !/!! bash commands are also gated.
 *
 * Status shows as "ro: on/off" in the footer status line (via the official
 * ctx.ui.setStatus API — the extension-status line under the model line).
 */

export default function (pi: ExtensionAPI) {
  let ro = false;

  const WRITE_BLOCK_REASON = "Read-only mode is active. Writes are blocked — run /ro to allow them.";

  const STATUS_KEY = "ro-mode";

  function syncStatus(ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1]) {
    // Official footer status line. NOTE: pass a string (never null — the
    // footer calls .replace() on it and crashes on null).
    ctx.ui.setStatus(STATUS_KEY, ro ? "ro: on" : "ro: off");
  }

  pi.on("session_start", (_event, ctx) => {
    ro = false; // fresh state per session
    syncStatus(ctx); // show "ro: off" immediately, no /ro needed
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!ro) return;

    // 1) Block all write actions outright
    if (event.toolName === "write" || event.toolName === "edit") {
      return { block: true, reason: WRITE_BLOCK_REASON };
    }

    // 2) Gate every bash command with a confirmation prompt
    if (event.toolName === "bash") {
      const command = (event.input as { command?: string }).command ?? "";

      if (!ctx.hasUI) {
        // No way to ask — err on the side of safety
        return { block: true, reason: `Read-only mode: cannot confirm command "${command}" (no UI).` };
      }

      const ok = await ctx.ui.confirm(
        "Read-only mode: allow command?",
        `Allow: "${command}"?`,
      );
      if (!ok) {
        return { block: true, reason: "Blocked by read-only mode (user declined)." };
      }
    }
  });

  // 3) Also gate user-typed ! / !! bash commands
  pi.on("user_bash", async (event, ctx) => {
    if (!ro) return;

    if (!ctx.hasUI) {
      return {
        result: { output: "Blocked by read-only mode (no UI to confirm).", exitCode: 1, cancelled: false, truncated: false },
      };
    }

    const ok = await ctx.ui.confirm(
      "Read-only mode: allow command?",
      `"${event.command}" may modify the system. Allow it?`,
    );
    if (!ok) {
      return {
        result: { output: "Cancelled by read-only mode.", exitCode: 1, cancelled: true, truncated: false },
      };
    }
  });

  pi.registerCommand("ro", {
    description: "Toggle read-only mode",
    handler: async (_args, ctx) => {
      ro = !ro;
      syncStatus(ctx);
      ctx.ui.notify(
        ro
          ? "Read-only mode ON: writes blocked, mutating shell commands require confirmation"
          : "Read-only mode off",
        ro ? "warning" : "info",
      );
    },
  });
}
