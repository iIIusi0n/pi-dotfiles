import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { extractComment, verifyCommand, withLoader } from "./auto-approve.ts";

/**
 * /ro — read-only mode for Pi (toggle).
 *
 * While active:
 *  - All write/edit tool calls are blocked.
 *  - All bash commands are verified in READ-ONLY mode by the LLM auto-approve
 *    verifier: the selected model checks that the command will not modify the
 *    system (no writes, deletes, installs, git state changes, ...). The
 *    agent's own message is passed to the verifier as the stated reason.
 *  - User !/!! bash commands are verified the same way.
 *
 * Denials are fail-closed; verification errors/timeouts block the command.
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

    // 2) Verify every bash command with the LLM auto-approve verifier in
    //    read-only mode: it must check that the command will not modify the
    //    system. The agent's preceding message ("comment") explains why the
    //    command is needed and is included in the verification prompt.
    if (event.toolName === "bash") {
      const command = (event.input as { command?: string }).command ?? "";
      const model = ctx.model;

      if (!model) {
        // No way to verify — err on the side of safety
        return { block: true, reason: `Read-only mode: cannot verify command "${command}" (no model selected).` };
      }

      const verdict = await withLoader(
        ctx,
        `Read-only check via ${model.provider}/${model.id}…`,
        (signal) =>
          verifyCommand({
            command,
            comment: extractComment(ctx.sessionManager),
            mode: "read-only",
            model,
            modelRegistry: ctx.modelRegistry,
            signal,
          }),
      );
      if (!verdict) {
        return { block: true, reason: "Read-only mode: verification cancelled." };
      }
      if (!verdict.approved) {
        return { block: true, reason: `Read-only mode: ${verdict.reason}` };
      }
    }
  });

  // 3) Also verify user-typed ! / !! bash commands in read-only mode
  pi.on("user_bash", async (event, ctx) => {
    if (!ro) return;

    const model = ctx.model;
    if (!model) {
      return {
        result: { output: "Blocked by read-only mode (no model selected to verify with).", exitCode: 1, cancelled: false, truncated: false },
      };
    }

    const verdict = await withLoader(
      ctx,
      `Read-only check via ${model.provider}/${model.id}…`,
      (signal) =>
        verifyCommand({
          command: event.command,
          mode: "read-only",
          model,
          modelRegistry: ctx.modelRegistry,
          signal,
        }),
    );
    if (!verdict || !verdict.approved) {
      return {
        result: {
          output: `Blocked by read-only mode: ${verdict?.reason ?? "verification cancelled"}`,
          exitCode: 1,
          cancelled: verdict === null,
          truncated: false,
        },
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
          ? "Read-only mode ON: writes blocked, shell commands are LLM-verified to be read-only"
          : "Read-only mode off",
        ro ? "warning" : "info",
      );
    },
  });
}
