# Contributing to sql-optima

Thanks for helping improve this GitHub Action. Please also read the [Code of Conduct](.github/CODE_OF_CONDUCT.md).

## Development setup

Requires Node.js 20+.

```bash
git clone https://github.com/ale94lko/sql-optima.git
cd sql-optima
npm ci
```

## Quality checks

```bash
npm test
npm run test:coverage
npm run build
```

After changing `src/` or lockfile dependencies, commit the rebuilt `dist/` in the same change. Consumers run the Action from `dist/index.js` without installing npm dependencies on their runners.

## Pull requests

1. Fork the repository and create a focused branch.
2. Keep changes small: one feature or fix per PR, with tests that pin the new behavior.
3. Link the PR to the related issue when applicable.
4. Fill out the pull request template.

## Reporting bugs and ideas

Use the [issue templates](https://github.com/ale94lko/sql-optima/issues/new/choose). Search existing issues first to avoid duplicates.

## Security

Do not report vulnerabilities in public issues. See [SECURITY.md](SECURITY.md).
