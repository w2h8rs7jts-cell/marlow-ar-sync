# marlow-ar-sync

A small, standalone job that keeps Accelerated Reader (AR) BookFinder
data — AR quiz number, ATOS book level, interest level, AR points — in
sync with the books Marlow students are reading, without the Marlow
app itself ever talking to arbookfind.com.

## Why this is a separate repo

arbookfind.com has no public API. The only way to get this data is to
drive their real search form (a headless browser here, via
[Playwright](https://playwright.dev)), which is inherently fragile —
it breaks whenever Renaissance changes their page markup, with no
changelog or warning. Keeping that fragility in its own repo, on its
own schedule, means it can break, get fixed, or get ripped out
entirely without ever touching the Marlow app itself. The app only
ever reads a plain Supabase table (`ar_book_data`) that this job keeps
filled in.

**Before relying on this long-term:** arbookfind's terms of use aren't
written with "an automated nightly job" in mind. This is built to be
as light-touch as something automated can be — small incremental
batches of new/unmatched books only, polite delays between requests,
never a full re-crawl (see `MAX_LOOKUPS_PER_RUN` and the staleness
check in `scripts/sync-ar-data.mjs`) — but that's a mitigation, not a
guarantee of compliance. Worth treating as a deliberate call, not just
an engineering default.

## How it works

1. **`supabase/ar_book_data.sql`** — run once, by hand, in the Marlow
   Supabase project's SQL Editor. Creates `ar_book_data`, keyed by a
   normalized `title|author` string (not ISBN — nothing in Marlow's
   `reader_books` table currently captures one). Read-only to the app;
   only this job's service-role key writes to it.
2. **`.github/workflows/sync-ar-data.yml`** — runs nightly (09:07 UTC)
   via GitHub Actions, and can also be triggered manually from the
   Actions tab (with an optional lower `sync_limit` for a quick test
   run).
3. **`scripts/sync-ar-data.mjs`** — pulls distinct title/author pairs
   from `reader_books` that don't have an `ar_book_data` row yet (or
   whose `not_found` result is more than 30 days old — a quiz can get
   added after the first miss), looks each one up on arbookfind, and
   upserts the result.

## Setup

1. Run `supabase/ar_book_data.sql` against the live Marlow Supabase
   project (SQL Editor), then `notify pgrst, 'reload schema';` (the
   script already does this at the end of the file).
2. In this repo's **Settings → Secrets and variables → Actions**, add:
   - `SUPABASE_URL` — the Marlow project's Supabase URL.
   - `SUPABASE_SERVICE_ROLE_KEY` — the service-role key (not the anon
     key — this job needs to write past RLS). Treat this the same as
     every other service-role key in the main project: never commit
     it, never log it.
3. Trigger a manual run from the **Actions** tab with a small
   `sync_limit` (5 or so) to confirm it actually finds AR data on the
   live site before letting the nightly schedule take over.

## Known gap: this is unverified against the live site

The search/result selectors in `scripts/sync-ar-data.mjs` were
written from arbookfind's documented search fields, not confirmed
against the live rendered page — this sandbox's outbound network
access doesn't reach arbookfind.com to test against it directly.
**Expect the first real run to need a selector fix.** The script
saves a screenshot + the page's HTML to `diagnostics/` on the first
miss or any hard failure each run, uploaded as a workflow artifact —
check that before guessing at what broke.

## Not yet done: wiring this into the Marlow app itself

This repo only fills in `ar_book_data`. Showing an AR quiz
badge/level in the Reader UI is separate follow-up work in the main
StudyBridge/Marlow repo (new query against this table, keyed by the
same normalized `title|author` the app already has on `reader_books`)
— not included here.
