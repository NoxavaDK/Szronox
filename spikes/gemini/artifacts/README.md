# Artifacts

Two directories, with different rules.

- `private/` — **gitignored.** Raw live output goes here: full provider bodies,
  live source URLs, provider error strings. Redirect the live run into it:

  ```sh
  mkdir -p artifacts/private
  npm run live > artifacts/private/live-$(date -u +%Y%m%dT%H%M%SZ).json
  ```

- this directory — committed. Only redacted, provenance-labelled summaries
  belong here, and only once a live run has actually happened.

Nothing has been committed here yet, because no live run has been possible in
this environment: no `GEMINI_API_KEY` or `GOOGLE_API_KEY` was configured. See
`../docs/acceptance-matrix.md` for the resulting UNVERIFIED verdicts.

A synthetic run is not an artifact of provider behaviour and must not be filed
here as if it were one.
