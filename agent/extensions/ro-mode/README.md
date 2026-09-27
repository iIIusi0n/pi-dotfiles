# ro-mode

`/ro` toggles read-only mode for the session. While active:

- `write` and `edit` tool calls are blocked outright.
- Every `bash` command is verified in **read-only** mode by the `auto-approve`
  verifier: the model must confirm the command does not modify the system.
- User-typed `!` / `!!` shell commands are verified the same way.
- A `<read_only_mode>` system-prompt section is injected while active, so the
  model knows the mode before its first blocked call.
- Footer status line shows `ro: on` / `ro: off` via `ctx.ui.setStatus`.

Denials are fail-closed; verification errors and timeouts block the command.

Depends on the sibling `auto-approve` package for `verifyCommand`,
`extractComment`, and `withLoader`. Restore the development link with:

```bash
npm install --ignore-scripts --legacy-peer-deps
```
