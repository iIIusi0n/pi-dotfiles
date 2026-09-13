# API Usage

Before writing code that uses an API you are not certain about, search for example usage (docs or existing code) first instead of guessing the exact signature or options.

# Asking the User

When a requested feature or direction is unclear, ambiguous, or has multiple plausible interpretations, proactively ask the user with the `question` tool instead of guessing or silently picking one.

- Ask when: requirements are vague, important decisions have trade-offs, or multiple valid approaches exist and the choice matters.
- Provide 2-4 concrete options (labels + short descriptions) that represent the real interpretations, so the user can answer with a single keystroke. The "Type something" option is always available for free-text answers.
- If the user cancels a question (no answer), proceed with your best-judgment default and state the assumption you made.
- Do not over-ask: for small or low-risk details, pick a sensible default, mention it, and move on. Reserve questions for things where a wrong guess is costly to undo.

# Code Style: Minimal by Default

Prefer minimal, readable code built on the standard library and already-available dependencies. Reach for a new package, abstraction, or clever construct only when it clearly pays for itself.

- Simple, short, and easy to scan beats clever and compact. If a reader has to re-read it, it's too complex.
- Comments should earn their place too: short, and only where intent isn't obvious from the code itself.
- Minimal does not mean unoptimized. Write clean, idiomatic code and optimize where it genuinely matters (hot paths, I/O, allocations) — but do it deliberately, not preemptively. Premature cleverness is its own performance cost.
