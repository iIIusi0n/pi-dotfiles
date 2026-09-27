# less

`/less` opens a full-screen, `less`-style read-only pager over the current
session transcript. It reuses Pi's own chat components (user and assistant
messages, tool executions, bash executions, compaction summaries, custom
messages), so the paged view matches the normal session view. The session is
never mutated.

Only imports `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`,
both supplied by the Pi host.
