# Claude Project Instructions

Follow the canonical working agreement in `AGENTS.md`.

When the local `backlog/` exists:

- select only eligible work from `backlog/todo/`;
- do not pick blocked tasks or tasks with unmerged dependency PRs;
- move selected work to `in-progress/` before implementation;
- mark versioned work done when its PR opens, recording the PR URL and date;
- return work to `todo/` or `blocked/` if its PR closes unmerged; and
- update `backlog/ROADMAP.md` whenever status, dependency, scope, or sequence
  changes.

The backlog is private and non-versioned. Never commit or force-add `backlog/`,
and never add it to `.gitignore`. Verify `git check-ignore -q backlog` before
staging. If the backlog is absent, continue normal requested work and do not
invent or recreate its contents unless explicitly requested.
