# VPS-00 — root handoff

Completed 2026-09-14 by root gpt-6-astra in /Users/kubabilski/Desktop/SzroNox. User authorized VPS-00 only and explicitly instructed execution now before Opus integration. Baseline f0e8e9b; no branch merge or agent dispatch. Changes are uncommitted for review; no new commit ID.

## Owned files

- AGENTS.md: current authorization and VPS infrastructure authority.
- docs/implementation/T00-contracts.md: replace Supabase/JWT infrastructure clauses; preserve product sections.
- docs/implementation/tasks.md: update current authorization and append VPS status; preserve pre-existing T08/T04 entries.
- docs/implementation/VPS-00-contracts.md: exact authentication/session, upload renewal/private storage, database/migration seams, ownership and acceptance gates.
- packages/contracts/src/index.ts: additive LoginRequest/AuthSessionResponse, attachment transport request/response types and RATE_LIMITED error code. Existing domain fields/payloads unchanged.
- apps/api/package.json, apps/worker/package.json, package-lock.json: exact new dependency pins. No versions of previously locked packages changed or disappeared, checked against HEAD.
- docs/implementation/VPS-00-result.md: this handoff.

Pre-existing untracked deploy/ files and all feature worktrees were untouched. Root package.json and web package.json were unchanged. No feature runtime code, migration SQL, visual assets or deployment configuration was edited.

## Acceptance results

| Criterion | Result |
| --- | --- |
| Provider-neutral infrastructure seams pinned | PASS: opaque cookie sessions, server identity, private upload/read, transport-only renewal, pg pools and explicit migrations |
| Stable IDs and draft isolation | Contract pinned; existing IDs/partitions retained, server-confirmed bootstrap, stale response generation guards; runtime verification belongs to VPS-01/07 |
| Frozen product invariants | PASS by scoped diff: no Reel state, hooks, publication, verification, input or recovery payload changes |
| Parallel ownership | PASS: VPS-01 auth, VPS-02 attachments, VPS-03 database/deploy files disjoint; lead later owns shared route composition and browser upload wiring |
| Dependency lock | PASS: exact new pins; no existing locked package upgrades/removals |
| Build/typecheck | PASS on current root scaffold |
| Existing scaffold tests | PASS 11/11 with loopback socket permission |
| Native dependency smoke | PASS: Argon2id positive/negative verification, sharp PNG decode, pg import, Fastify cookie/rate-limit registration |
| VPS/production/agent changes | None |

Dependency versions: API argon2 0.45.1, pg 8.23.0, @fastify/cookie 11.1.2, @fastify/rate-limit 11.2.0, sharp 0.35.4; worker pg 8.23.0; API/worker @types/pg 8.23.1. Libraries are installed but no application adapter is activated by this task.

## Exact verification commands

Run from /Users/kubabilski/Desktop/SzroNox:

```sh
npm run build
npm run typecheck
npm test
git diff --check
npm ls --workspace @szronox/api --workspace @szronox/worker --depth=0
```

Initial sandboxed npm test: 5 passed, six failed with listen EPERM on 127.0.0.1. Repeating the same command with authorized loopback access passed 11/11; no test or source edits were needed. npm ls exited 0; it also reported optional sharp WASM support packages (@img/sharp-wasm32, @emnapi/runtime, tslib) as extraneous in the shared local node_modules. No broad cleanup was performed while other worktrees are active. These do not enter the shipped dependency graph unless the lockfile includes them.

Native/plugin smoke command (synthetic password only; hashes/secrets not printed):

```sh
node --input-type=module -e 'import assert from "node:assert/strict"; import argon2 from "argon2"; import sharp from "sharp"; import pg from "pg"; import cookie from "@fastify/cookie"; import rateLimit from "@fastify/rate-limit"; import Fastify from "fastify"; const hash=await argon2.hash("VPS-00 synthetic dependency probe",{type:argon2.argon2id,memoryCost:19456,timeCost:2,parallelism:1}); assert(await argon2.verify(hash,"VPS-00 synthetic dependency probe")); assert(!(await argon2.verify(hash,"wrong"))); const bytes=await sharp({create:{width:1,height:1,channels:3,background:"white"}}).png().toBuffer(); assert.equal((await sharp(bytes).metadata()).format,"png"); assert.equal(typeof pg.Pool,"function"); const app=Fastify(); await app.register(cookie); await app.register(rateLimit,{max:10,timeWindow:1000}); await app.ready(); await app.close(); console.log("PASS: Argon2id positive/negative verification; native image decode; pg import; Fastify plugins register");'
```

Existing lock versions comparison (no output means no version changes/removals):

```sh
node --input-type=module -e 'import fs from "node:fs"; import {execFileSync} from "node:child_process"; const before=JSON.parse(execFileSync("git",["show","HEAD:package-lock.json"],{encoding:"utf8"})); const after=JSON.parse(fs.readFileSync("package-lock.json","utf8")); for(const [name,p] of Object.entries(before.packages)) {const q=after.packages[name]; if(q && p.version!==q.version) console.log(name,p.version,"->",q.version); if(!q) console.log("removed",name);}'
```

## Limitations and next gate

Checks ran locally on Node v25.9.0/macOS, not the VPS Node 22/Linux runtime. Linux native dependency installation remains a deployment-image gate. No real PostgreSQL, auth endpoint, upload endpoint, worker transaction or HTTPS/browser acceptance was executed. This is contracts/dependencies completion, not milestone completion.

Opus's final T05/T06/T08 baseline still needs integration reconciliation, including its PGlite dev dependency and any additive transport types. No accepted correction work was re-audited. Check reserved migration filenames against that baseline before dispatch. Domain error consumers must add Polish RATE_LIMITED mapping during VPS-01. CSRF/upload secrets and the hostname must be configured by later approved work; no credentials were provisioned.

VPS-01/02/03 remain proposed only. Their dispatch and VPS-04 onward require explicit approval; there is no automatic continuation.
