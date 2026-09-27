# auto-approve

LLM-verified approval for every `bash` command the agent requests. The selected
model receives the command plus the agent's own preceding message (the
"comment") and answers with one line: `APPROVE` or `DENY: <reason>`.

Fail-closed: verification errors, timeouts, and user aborts all block the
command. Approvals are silent; denials return to the agent as the tool result.

Commands:

- `/approve` — show status
- `/approve on|off` — toggle verification
- `/approve model` — clear the verifier-model override (use the selected model)
- `/approve model <ref>` — pin a verifier model (`provider/id` or substring)
- `/approve test <cmd>` — run the "safe" verifier once and report the verdict
- `/approve test-ro <cmd>` — same check in "read-only" mode (must not modify the system)

`verifyCommand()`, `extractComment()`, and `withLoader()` are exported so other
extensions can reuse the verifier — `ro-mode` imports them. This package
therefore declares `main`/`exports` and acts as a library as well as an
extension; consumers link it with `npm install --ignore-scripts --legacy-peer-deps`.
