# SOURCE-01 — bounded article extraction and source errors

Branch codex/source-01; baseline b5a8946 (deployed source d4cddd3 plus handoff documentation). LIST-01 is deliberately absent. Implementation only; not merged or deployed. No Gemini calls and no changes to user data or VPS configuration.

## Behavior

- HTML/plaintext download bounded to 2 MiB of actual streamed bytes; oversized declared Content-Length rejects before reading. DNS pinning, private-address rejection, two-redirect bound and MIME/encoding restrictions remain. Each hop also has a six-second wall-clock deadline.
- Inert linkedom parsing plus Mozilla Readability extracts article content without executing scripts or loading images, stylesheets or linked resources. Navigation, footer/sidebar/dialog elements and common promotional wrappers are excluded. Retains an explicit headline and lead paragraphs when separately structured, as on Onet. Removes Onet's embedded follow widget.
- Separate 20,000-character article limit is unchanged in magnitude, but now fails explicitly instead of silently slicing an article. Too-large HTML, too-long text, blocked access, unavailable source, unsupported URL/content and missing article text have distinct safe errors and Polish UI messages.
- Authored input, AI application semantics, image attachments and programme retrieval remain unchanged. Source provenance still retains the bounded extracted text and HTML hash.

## Verification

Commands in this worktree:

```
npm run build --workspace @szronox/worker
node --test apps/worker/dist/ai/source.test.js apps/worker/dist/ai/actions.test.js
npm run typecheck --workspace @szronox/contracts
npm run typecheck --workspace @szronox/web
npm run build --workspace @szronox/web
git diff --check
```

All PASS; 12 worker tests (six source tests and six existing action tests). Source tests cover oversized HTML containing scripts, excluded boilerplate, entity decoding, missing text, explicit text overflow, overstated/understated length, streamed body cutoff, exact size boundary, URL protection, and separate lead/headline retention.

The reported Onet URL was fetched once locally with curl (identity encoding, 2 MiB bound) into `/tmp/source-01-onet.html`, then read through the compiled extractor. Actual HTML: 440,166 bytes. Final extracted text: 2,460 characters. Headline and lead present; embedded Google follow prompt absent; paragraph boundaries retain whitespace. This is deterministic extraction evidence, not a paid AI test.

## Files

- apps/worker/src/ai/source.ts
- apps/worker/src/ai/source.test.ts
- apps/worker/src/ai/jobs.ts
- apps/worker/package.json
- package-lock.json
- packages/contracts/src/index.ts (additive error codes)
- apps/web/src/data/errors.ts (Polish source error copy)
- docs/implementation/SOURCE-01-result.md

## Remaining gates / rollout

Real DEV deployment and a new user-triggered Opracuj attempt are UNVERIFIED. Existing failed jobs retain their old error code; the fix applies to new attempts. Roll out worker and web together so new error codes render correctly. Use the existing dc-gemini.sh deployment wrapper and preserve the current corpus release/migrations; this task has no migrations. Do not deploy LIST-01 with this fix implicitly.

Parser heuristics do not guarantee extraction from every publisher; paywalls, JS-only content, access challenges and compressed responses despite identity negotiation remain unsupported and must never be treated as successful retrieval. No browser execution, URL Context fallback or Google Search was added. No generic truncation or paywall bypass.
