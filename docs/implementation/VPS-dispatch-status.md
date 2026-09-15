# VPS batch dispatch — 2026-09-14

Root contract commit: 5444ae0. Prepared shared baseline: 43fbd23dea48d8a593557bbc30558cf748f28ec4 on codex/vps-batch-base. Includes Opus T08 0b2d6b0, preserving its T05/T06 history, plus VPS-00 dependencies/contracts and unchanged existing scaffold deployment files. Root master was not merged with the feature branch; preparation happened in an isolated worktree.

| Task | Allocation/status | Worktree and branch |
| --- | --- | --- |
| VPS-01 | Manual Opus only; prompt ready, not launched by Codex | .worktrees/vps-01-auth; codex/vps-01-auth |
| VPS-02 | Running gpt-5.6-sol/high; /root/vps02_storage | .worktrees/vps-02-storage; codex/vps-02-storage |
| VPS-03 | Running gpt-5.6-luna/high; /root/vps03_environment | .worktrees/vps-03-environment; codex/vps-03-environment |

All paths are under /Users/kubabilski/Desktop/SzroNox. Exact worktree start commit is the prepared baseline above. No fallback model used. Manual prompt: VPS-01-opus-handoff.md.

Pinned before launch: auth 0003_vps_auth.sql; storage 0004_vps_storage.sql; historical migrations 0001/0002 moved only by VPS-03; APP_STORAGE_ROOT=/var/lib/szronox/storage with scoped app_storage volume and UID:GID 1000:1000; /me session recovery; two-user provisioning/configuration and expiry/CSRF/throttle contract. See VPS-batch-dispatch.md.

Prepared baseline merge required only combining the PGlite dev dependency with VPS dependencies in apps/api/package.json and reconciling lockfile. Initial build used ancestor dependencies and failed with missing PGlite TS2307. Isolated `npm ci --no-audit --no-fund` in .worktrees/vps-batch-base installed 187 locked packages; `npm run build && npm run typecheck` then passed across all four workspaces. `git diff --check` passed. No correction implementation was changed or broadly re-audited. These are local baseline composition checks, not auth/storage/real-PG acceptance.

No VPS mutation. No VPS-04 dispatch. Each child stops with scoped commit/results; root reconciles once after all three finish and returns the next proposal for approval.


## Completed and reconciled — 2026-09-15

All three tasks completed: Opus b289569, Sol 5568699, Luna d2b5e9c. No agents remain active for these tasks. Combined branch codex/vps-reconcile at b478100 preserves their histories and contains the bounded integration report and VPS-04 proposal. Its worktree is .worktrees/vps-reconcile. Earlier "running" rows above are dispatch history, not current status. No VPS changes; VPS-04 awaits explicit approval.
