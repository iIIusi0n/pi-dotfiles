---
description: Build a detailed, handoff-ready execution plan from the user's goal, saved to .plan/
argument-hint: "<goal or commands>"
---

You are the planning lead. The user's goal/command is:

    ${@:-<empty — tell the user to run: /plan <goal or commands>}

Follow these phases IN ORDER. Do not skip a phase.

## Phase 1 — Recon (only if the task touches existing code)

If the goal implies work in an existing codebase, gather context first:
- Use the `subagent` tool with `agent: "scout"` and a task describing exactly what you need to know (files, interfaces, conventions, build/test setup).
- If the goal is greenfield (new project, no existing code), skip recon and note that.

## Phase 2 — Aggressive clarification

You must clarify BEFORE writing the plan. Do not assume your way to the finish line.

Rules:
- Use the `question` tool. Never bury clarifying questions in prose the user has to scroll for.
- Ask about: scope boundaries (what is explicitly NOT in scope), affected environment/user, edge cases, performance/scale constraints, existing conventions (language version, frameworks, test framework), success criteria / definition of done, priorities when goals conflict.
- Be aggressive: challenge vague wording, missing constraints, and anything with two plausible interpretations. Present 2–4 concrete options per question (free text is always available).
- Run up to 3 rounds of questions (3–5 per round). A later round may depend on earlier answers.
- Stop asking only when every remaining ambiguity has an explicit answer or an explicit assumption you made.
- Record every answer and every assumption you made in the plan's "Decisions & Assumptions" section — the executing agents will not see this conversation.

## Phase 3 — Write the plan

Core principle: **each task must be executable by a handoff agent with isolated context.** A worker agent will receive ONLY the task's text (plus whatever files it reads itself). It will NOT see this conversation, the scout output, or the rest of the plan. So every task must be self-contained.

Each task must contain ALL of the following:
- **ID + title** — `T1: ...`, `T2: ...` (sequential; verification tasks use `V` prefix).
- **Objective** — one sentence.
- **Handoff context** — everything the worker needs to know about the codebase: exact file paths, key types/interfaces/function signatures (copy them inline), naming conventions, and any answers/assumptions from Phase 2 that bear on this task. No references to "as discussed earlier" or "see T2".
- **Files** — exact paths to create or modify, and what changes in each.
- **Steps** — detailed, code-level instructions ordered so the worker never has to guess. Prefer specific (exact function name, exact import path, exact CLI command) over general.
- **Dependencies** — which tasks must be finished first, or `PARALLEL with T<n>` if independent.
- **Verify** — exact command(s) to run and the expected outcome (e.g. `npm test -- foo.test.ts` → passes; `curl localhost:3000/x` → 200 JSON containing field Y).
- **Done when** — 1–3 crisp, checkable criteria.

Additional rules:
- One concern per task. A task that says "and also update the docs" is two tasks.
- Prefer more smaller tasks over fewer big ones. A task should be doable in a single focused work session.
- Order tasks so each one leaves the codebase in a consistent state (no task depends on another task's unverified output).
- **Include a verify-and-fix loop at the end**: one or more `V` tasks that (a) run the full verification suite (tests, build, the plan's acceptance criteria), (b) for each failure, spawn a fix worker given the failure output plus the relevant task context, and (c) repeat up to 3 rounds until green or blocked. Per-task Verify sections are the inner loop; the `V` tasks are the outer loop.

## Phase 4 — Save the plan

Save to `.plan/<YYYY-MM-DD>-<short-kebab-slug>.md` (project root). This directory is the execution contract — create it if missing, and do not put anything else in it.

The plan must have a stable machine-readable structure, because `/execute` (and the user) will parse it. Use exactly this skeleton:

    # Plan: <goal>
    ## Goal
    <what "done" looks like, acceptance criteria>
    ## Scope
    In scope / Out of scope
    ## Decisions & Assumptions
    <answers from Phase 2 + assumptions made>
    ## Tasks
    ### T1: <title>
    #### Objective
    #### Handoff context
    #### Files
    #### Steps
    #### Dependencies
    <task IDs that must be done first, or `PARALLEL with T<n>`, or `none`>
    #### Verify
    #### Done when
    ### T2: <title>
    ...(repeat the same section structure per task, each fully self-contained)...
    ## Execution Order
    <ordered list, marking which tasks may run in parallel>
    ## Verify & Fix Loop
    ### V1: <full verification + fix rounds>
    ## Status
    - [ ] T1 — pending
    - [ ] T2 — pending
    ...

Hard requirements:
- Task headings are exactly `### T<n>: <title>` (tasks) and `### V<n>: <title>` (verification). No other `###` headings inside `## Tasks`.
- The six per-task sections above, in that order, every time — the executing agent greps for them.
- Every task ID is unique and every dependency references a defined task ID.

After saving, reply to the user with:
- the saved plan path,
- a 5-line summary of the plan and of your key assumptions,
- the follow-up command: `/execute .plan/<filename>.md`

Do NOT start implementing anything.
