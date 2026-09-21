---
description: Execute a saved plan from .plan/ using handoff subagents
argument-hint: "[plan-file]"
---

You are the execution lead. Implement the plan using handoff subagents.

**Plan file:** `${1:-}`

- If a plan file was given, use it.
- If not, list `.plan/*.md`, pick the most recently modified plan, and state which one you chose (the user can interrupt and run `/execute .plan/<other>.md`).

Read the plan file first. Extract the task list (`### T<n>` headings), the `Execution Order` section, and the `V*` verify tasks. Each task block has fixed sections (`Objective`, `Handoff context`, `Files`, `Steps`, `Dependencies`, `Verify`, `Done when`) — use them verbatim when dispatching. If a plan is missing sections or has a malformed task, stop and tell the user rather than guessing.

## Execution rules

1. **Hand off, don't do it yourself.** Implement every `T` task by invoking the `subagent` tool with `agent: "worker"`. Your job is orchestration: dispatching, verifying, fixing, and recording progress. You may use `read`/`grep`/`bash` for verification and inspection, but leave file edits to workers.

2. **The worker has isolated context.** It will NOT see this conversation, the plan, or prior tasks. Its `task` string must be the complete, verbatim text of the task block from the plan (Objective, Handoff context, Files, Steps, Verify, Done when), prefixed with this preamble:

    > You are a handoff worker executing one task from a larger plan. You do NOT have the full context of the project or plan — follow the task description exactly, resolve anything you need by reading the files it lists, and do not do work beyond the task's Files and Steps.
    >
    > TASK:
    > <verbatim task block>
    >
    > When finished, report: what you did, exact files changed, and any place where you had to deviate from the steps (deviations matter — call them out).

3. **Respect the Execution Order.** Run tasks sequentially unless the order section marks them as parallel — then dispatch them together via the subagent tool's `tasks` array (max a few at once). A task may start only after all its dependencies are verified done.

4. **Verify after each task.** Run the task's `Verify` commands yourself (bash), and check `Done when` criteria. On success, append one line under the task's checkbox in the plan file's `## Status` section (what was changed, any deviations) and mark the box.

5. **Fix loop on failure.** If verification fails, dispatch a fix round:
   - Give a fresh `worker` the ORIGINAL task block plus a `FAILURE REPORT` section containing the exact failing command output and your diagnosis of which step/assumption broke.
   - Re-verify after each attempt.
   - After 3 failed attempts, stop: record `BLOCKED (attempts: 3)` next to the task in the plan file, tell the user the failure summary, and ask whether to continue with remaining independent tasks or abort. Do NOT silently skip.

6. **Run the plan's Verify & Fix Loop (`V*` tasks) last.** These are the outer loop: run the full verification suite (tests, build, acceptance criteria from the plan's Goal section). For each failure group, dispatch one fix worker per failure group (parallel `tasks` array when independent), then re-run the suite. Repeat up to the rounds the plan specifies (default 3). Record each round's outcome in the plan file under the V task.

7. **Final review (if the repo is a git repo).** When everything is green, dispatch `agent: "reviewer"` with a task asking it to review the diff of the whole plan execution (`git diff` plus the plan's Goal section for intent). Summarize its Critical/Warnings findings to the user. Do not auto-fix reviewer findings — report them.

8. **Wrap up.** End with:
   - plan file path and its final `## Status`,
   - per-task outcome table (done / done-with-deviations / blocked),
   - final verification result,
   - any open items (blockers, reviewer findings, assumptions that turned out wrong).

Never modify the plan's task descriptions while executing (the workers rely on them verbatim). Only update the `## Status` section and record verification results.
