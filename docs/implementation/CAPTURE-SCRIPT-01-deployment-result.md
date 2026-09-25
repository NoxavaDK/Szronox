# CAPTURE-SCRIPT-01 DEV deployment

Date: 2026-09-25. The user explicitly authorized deployment to DEV. Source commit `d75c94e` (implementation `489a592`) runs as image `szronox-dev:d75c94e`, ID `sha256:8f90dd4101fba6d1df1264c13b270fa664a38876971b0ac6b599dec75dea004a`. No migration or secret change was needed.

The committed archive SHA-256 was `35b060f68b085f6dc8e5859e4e7073b1b10cfba701c845cfa7397be743090f8c` and verified after transfer. Previous source, image and config were retained under `/opt/szronox-dev/app.pre-d75c94e`, `szronox-dev:4f7cfbb`, and `/opt/szronox-dev/backups/pre-d75c94e/`. The backup contains a 665,924-byte PostgreSQL custom dump and checksums. The migration-inventory query used an incorrect table name and produced no inventory; no migrations were run or required by this commit.

Host build with the existing `/opt/szronox-dev/config/Dockerfile.deploy` passed. With zero queued/running AI jobs, only the DEV API and worker were recreated through `config/dc-gemini.sh up -d --no-deps api worker`. Both run the new image with zero restarts. `/api/v1/ready` returned `ready` over loopback port 3011 and `https://dev.szronox.zieloni.tech`; `/`, `/sw.js`, and `/manifest.webmanifest` returned HTTP 200. The running web bundle contains `Gotowy skrypt`.

The Caddyfile SHA-256 remains `c672bd759e6de23cb4367544c23e3349b81e6d638db6c3a7e40f1109a67a9a03`. Existing Task Tracker, Cutroom, SzroNox production, and DEV PostgreSQL containers retained their previous start times. DEV had 23 Reel rows after rollout. No provider, kDrive, or production service was changed.

The user-designated same-sex-marriage Reel was read without mutation. Its saved publication fields remain empty; the latest successful `generate_publication` run holds the text supplied by the user as a proposal. Editorial review is in the conversation, not applied to the Reel.

Browser interaction with the Quick Add toggle and a live direct-script create request remain open real-world checks. Local API and queue tests, integrated build/typecheck, running-image bundle inspection, and DEV readiness are recorded separately; none is mislabeled as a completed browser interaction.

Code rollback: restore `app.pre-d75c94e` as `app`, restore `backups/pre-d75c94e/runtime.env` (release `4f7cfbb`), then run `config/dc-gemini.sh up -d --no-deps api worker`. Do not restore the database dump for a code-only rollback, because that would discard later DEV edits.
