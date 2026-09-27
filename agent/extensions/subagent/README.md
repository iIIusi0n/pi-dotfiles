# subagent

Delegates tasks to specialized agents by spawning a separate `pi` process per
invocation, each with an isolated context window. Agents are discovered from
`agent/agents/*.md`.

Modes:

- Single — `{ agent: "name", task: "..." }`
- Parallel — `{ tasks: [{ agent, task }, ...] }`
- Chain — `{ chain: [{ agent, task: "... {previous} ..." }, ...] }`

Output is captured through Pi's JSON mode. `agents.ts` handles frontmatter
parsing and agent discovery.

Only imports Pi packages and `typebox`, all supplied by the host.
