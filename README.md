# Pi configuration

Personal Pi customization in `agent/` (this directory is the Pi agent dir).

## Extension packaging convention

Every extension is its own directory under `agent/extensions/<name>/`:

```
agent/extensions/<name>/
├── package.json      # name, version, pi.extensions, peer/regular deps
├── index.ts          # extension entry point (default-exported factory)
└── README.md         # what it does, commands/tools it exposes
```

Dependency rules:

- Pi supplies `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`,
  `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox`.
  Declare them in `peerDependencies` with `"*"` and never bundle them.
- Real third-party libraries go in `dependencies` and install into that
  package's own `node_modules` (git-ignored), e.g. `openserp` → `@openserp/sdk`.
- When one extension imports another, declare the sibling as a peer dependency
  and link it through `devDependencies: { "<sibling>": "file:../<sibling>" }`,
  then run `npm install --ignore-scripts --legacy-peer-deps` in the consumer.
  The shared package needs `main`/`exports` pointing at its `.ts` entry.
- Packages load with separate module roots: never rely on another package
  resolving a dependency you did not declare.

`agent/settings.json` registers each package as a relative path
(`./extensions/<name>`), which makes them visible to `pi list` and
`pi config`. Auto-discovery of `agent/extensions/` still finds the same
`index.ts` entry, so registering a package does not load it twice.
