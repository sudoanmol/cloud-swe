# Anti-slop provenance

Source repository: [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop)

Source revision: unknown. The installed skill did not include an upstream commit
identifier. Its exact recoverable skill snapshot is identified by
`skills-lock.json`:

- source: `dmmulroy/anti-slop`
- skill path: `skills/install-anti-slop/SKILL.md`
- computed hash: `4031728fbe75bdcad6ee3208fd52b5d66e167b056fefee1fa9758e9a6cb9c0c8`
- source assets: `.agents/skills/install-anti-slop/assets/anti-slop/`

The asset directory was copied by
`.agents/skills/install-anti-slop/scripts/install.mjs` to
`tools/oxlint/anti-slop/` on 2026-09-10.

Installed paths include `index.ts`, `rules/`, `shared/`, `effect/`, and
`vendor/eslint-stylistic/`. The vendored Stylistic source retains its own
license and provenance in `vendor/eslint-stylistic/`.

Intentional deviations:

- No anti-slop plugin source files were modified during installation.
- The optional `effect/` plugin is included in the snapshot but is not registered
  because this repository has no direct `effect` package dependency.
- This file records repository-local provenance for the installed snapshot.
