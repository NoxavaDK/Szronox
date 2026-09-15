# VPS-04 — current approval and clarification

User approved VPS-04 on gpt-5.6-sol/high, one bounded implementation agent, on 2026-09-15. No nested agents or independent high-reasoning reviewer. This approval supersedes older proposal-only status.

The prepared worktree already contains a completed manual Opus implementation at 346f0e7. Preserve it and its evidence. Sol continues only unfinished work or concrete contract mismatches; do not duplicate implementation or rerun full suites merely for confirmation. Read VPS-04-result.md and inspect only relevant boundaries.

## APP_ORIGIN

Required runtime configuration, validated at startup and used for origin/CSRF enforcement. Missing or malformed values fail closed. Compose and runbook must use the same required-value contract; no invented hostname/default origin. Actual HTTPS hostname is supplied at VPS-05 when DNS/TLS is authorized. Its absence does not block preparing VPS-04. Synthetic origins in isolated tests are fixtures, not provisioned deployment hostnames.

## Startup/provisioning order

Runbook explicitly sequences: (1) PostgreSQL available; (2) migrations; (3) operator provisions/verifies exactly NOXAVA and SZRON; (4) API starts; (5) worker starts; (6) application readiness checks. Any role/grant/storage initialization prerequisites must fit this ordering before their consumers start.

Liveness may exist earlier, but readiness remains false if database unavailable, storage initialization failed, required secrets invalid/missing or configured two-user roster not ready. A running scaffold never means application readiness. Preserve these gates after startup as appropriate to runtime dependency failures.

## Execution boundaries

VPS-04-proposal.md retains the exact allowed files/modules and acceptance scope. No draft schema/product UI/domain mutation changes, historical migration rewrites, shared contracts or manifests/lockfiles. Report needed shared changes to root. Current handoff's blob reclamation and worker/API duplication items require root adjudication, not silent scope expansion.

Testing: changed-module compilation and targeted integration checks only. Accept existing unaffected evidence. No repeated full audit or early real-PG/browser/VPS gate attempts. No live VPS changes, credential provisioning, DNS/TLS or deployment. Stop with scoped commit, files, exact commands/results, classified findings, limitations and UNVERIFIED gates. Root then performs bounded integration review and prepares VPS-05; VPS-05 requires separate approval.
