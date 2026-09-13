# SzroNox implementation rules

- Discussion, documentation, code and identifiers are English. All application UI copy is Polish.
- The product architecture and UX are frozen except for explicitly approved corrections below. Preserve the visual language in `design/visual-language-v2`.
- The root agent is technical lead: owns shared contracts, invariants, architecture, review and integration. Delegate routine implementation to bounded coding agents.
- Currently authorized: T00, T01, T02, T03; T04 when an agent slot is available. Do not start other implementation tasks without further authorization.
- Read `docs/implementation/T00-contracts.md` and `docs/implementation/tasks.md` before work. Work only in your assigned worktree and file allowlist.
- Do not edit shared contracts, another agent's files, root dependencies or lockfiles unless assigned. Propose contract changes to the lead.
- Hooks are persistent `ReelHook` records, not a singular Reel.hook field. Requested AI hook generation appends alternatives; it never replaces existing hooks. No per-hook `Użyj` action. No hook analytics or complex versioning.
- Opracuj may suggest at most one existing library meme. Unknown IDs are invalid. Never attach/replace memes automatically.
- T16 AI-result composition is BLOCKED awaiting frozen mockups/specifications. Do not invent it from fixtures.
- Final writing prompts, Style Profile and editorial wording are NOT frozen. Diagnostic prompts and fixtures must be clearly labeled provisional. Do not turn them into production editorial prompts.
- No application features beyond scope: no analytics, calendar, autopublishing, large-file uploader, admin UI or new workflow states.
- Never print secrets. Live provider tests require configured test credentials; absent access is an explicit unverified gate, not a passing result.
- Do not provision paid resources, change real kDrive production data, deploy or send messages. Spikes may use explicitly designated disposable test resources only.
- Every handoff includes owned files, acceptance results, exact verification commands, remaining limitations and its commit ID if available. Do not merge your own branch.
