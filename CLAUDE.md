# CLAUDE.md

## What this repo is

A sandbox. It exists to try out ideas that may or may not become real projects.
Nothing here is production code, and nothing here should be treated as a shared
library, framework, or platform.

## The one rule that matters: projects are islands

**Every project lives in its own top-level subdirectory, and projects share
nothing with each other.**

```
/
├── CLAUDE.md
├── README.md
├── .gitignore
├── some-idea/          <- self-contained project
└── another-idea/       <- self-contained project, knows nothing about the first
```

Concretely:

- **No cross-project imports.** A file in `some-idea/` must never import,
  `require`, `source`, or otherwise reference anything in `another-idea/`.
- **No shared code.** There is no root `lib/`, `common/`, `utils/`, or
  `packages/`. If two projects need the same helper, copy it. Duplication is
  the correct answer here — it keeps each project deletable.
- **No root-level infra.** No root `package.json`, `pyproject.toml`,
  `Cargo.toml`, lockfile, `Makefile`, `docker-compose.yml`, virtualenv,
  `node_modules`, monorepo tooling (workspaces, Nx, Turborepo, uv workspaces),
  or shared linter/formatter/tsconfig at the root.
- **No shared dependencies.** Each project declares and installs its own, inside
  its own directory.
- **No shared CI.** If a project needs CI, that is a decision for that project.
  Do not add a root workflow that builds or tests everything.
- **No shared config or secrets.** Each project gets its own `.env.example`,
  its own config files, its own settings.

The test: deleting any project directory should leave every other project
building and running exactly as before, with no other edits needed.

## Working in this repo

- **Starting something new?** Create a new top-level directory for it. Do not
  bolt it onto an existing project because it looks adjacent.
- **Pick whatever stack suits the idea.** Projects do not need to agree on
  language, tooling, formatting, or structure. Consistency across projects is
  explicitly a non-goal.
- **Each project should carry its own README** with a one-line description of
  the idea and how to run it. Assume the reader has forgotten it exists.
- **Stay inside your project directory.** When working on a project, confine
  changes to that directory (plus this file or the root README when the change
  is genuinely repo-wide).
- **Tests, types, and polish are optional** and scoped per project. This is a
  place to find out whether an idea is any good, not to build it properly.
- **Abandoned experiments can just be deleted.** That is the point of the
  isolation.

## If an idea graduates

A project that is going to production leaves this repo. Extract it into its own
repository rather than hardening it in place or promoting its code to the root.
