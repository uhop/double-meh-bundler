# Contributing to double-meh-bundler

Thank you for your interest in contributing!

## Getting started

This project uses a git submodule for the wiki. Clone recursively:

```bash
git clone --recursive https://github.com/uhop/double-meh-bundler.git
cd double-meh-bundler
npm install
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the module map and dependency graph.

## Development workflow

1. Make your changes.
2. Lint: `npm run lint:fix`
3. Test: `npm test` (also `npm run test:bun`, `npm run test:deno`)
4. Type-check: `npm run ts-check` and `npm run js-check`

## Code style

- ESM (`import`/`export`) in all files.
- Formatted with Prettier — see `.prettierrc` for settings.
- Zero runtime dependencies; frameworks appear as devDependencies for conformance tests only.
- Keep `.js` and `.d.ts` files in sync for all modules under `src/`.
- Comments are _why_-markers only — never narrate what the code does.

## License

By contributing, you agree that your contributions are licensed under the same
[BSD-3-Clause](./LICENSE) license that covers the project.

## AI agents

If you are an AI coding agent, see [AGENTS.md](./AGENTS.md) for detailed project conventions, commands, and architecture.
