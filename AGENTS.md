# Agent Working Agreement

## Local backlog

The private working backlog, when present, lives in `backlog/`. It is excluded by
`.git/info/exclude` and must never be committed, force-added, copied into a commit,
or added to `.gitignore`. Before staging organizational work, run:

```sh
git check-ignore -q backlog
```

If `backlog/` is absent in a clone, continue normal requested work. Do not invent,
restore, or recreate private backlog contents unless the user explicitly asks.

## Task eligibility and lifecycle

- Pick only a task in `backlog/todo/` whose dependencies are implementation-ready
  and which has no open implementation PR.
- A dependency is implementation-ready only after its PR is merged. A task being
  `done` because its PR is merely open does not make downstream work ready.
- Never pick a task from `backlog/blocked/`. Every blocked task must state the
  blocker and an exact unblock condition.
- Before implementation, move the task to `backlog/in-progress/`, set its status
  accordingly, and update `backlog/ROADMAP.md`.
- For versioned work, opening a PR marks the task `done`: record the PR URL and
  opening date, set the status, move the file to `backlog/done/`, and update the
  roadmap. If the PR closes unmerged, return the task to `todo/` or `blocked/`.
- Research work is done only when its evidence memo, conclusion, and resulting
  follow-up tasks are recorded.
- Never work around a blocker by silently changing task scope.

## Task and roadmap maintenance

New task files use YAML frontmatter with `id`, `status`, `priority`, `phase`,
`type`, `depends_on`, and `created`. They contain Outcome, Context, Scope, Out of
Scope, Acceptance Criteria, Verification, Dependencies, and Handoff Notes.
Legacy entries without frontmatter remain valid; their directory determines
status.

Update `backlog/ROADMAP.md` whenever task status, dependencies, scope, or
sequencing changes. Keep task links, the dependency graph, and the separate
legacy maintenance lane accurate. Task IDs must be unique, dependencies must
resolve, and the dependency graph must remain acyclic.

Never run `git add -f backlog`.
