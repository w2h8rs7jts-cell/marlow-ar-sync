# Marlow AR identity sync

This proposed v2 importer returns **no confirmed AR quiz** when full book
identity is uncertain. The app continues to read a shared Supabase cache,
so previously confirmed exact matches do not require browsing at launch.

## Why the change

The prior importer opened the first result containing the first 20 title
characters and never checked its author. On October 6 it assigned quiz
169372 to **Star Wars: A New Hope: Ultimate Fan Edition Little Golden Book
by Geof Smith**. The official detail identifies 169372 as **LEGO Star Wars:
A New Hope by Emma Grange**. Search relevance and similar names are not
book identity.

## Conservative contract

- Separate `ar_book_matches_v2` table; old `ar_book_data` rows remain intact.
- Exact complete title and author, preserving subtitles, punctuation,
  edition words and digits. Only case and whitespace are normalized.
- A single official `Last, First` author can match a supplied `First Last`;
  multi-author lists, missing author and ambiguous names are not guessed.
- A supplied ISBN must pass its checksum and occur in the actual detail's
  ISBN table. ISBN-10 and corresponding ISBN-13 are equivalent. Invalid
  supplied ISBN never falls back to a title-only lookup.
- Official English Reading Practice details and exactly one accepted
  quiz are required. Full requested identity, matched title/author/ISBNs,
  detail URL, language, type, policy and date are retained. Ordinary
  clients can read only positive cache rows; unverified raw identities
  remain service-only.
- Current official Advanced Search fields are used. No title-prefix,
  first-result, whole-body regex or requested-title fallback.
- Complete bounded result pagination and all exact-title candidates are
  inspected. Incomplete or overly broad results defer without adopting a
  partial match. A successful search without a unique verified identity
  stores `unverified`, **not** a claim that no quiz exists anywhere.
- Transport, unknown selectors, invalid details and storage errors preserve
  prior rows, return a failed Actions run and do not become negative hits.

## SQL file names

The downloadable handoff calls the migration **AR-book-identity-verified-cache.sql**.
This repository stores the **identical SQL** at `supabase/ar_book_matches_v2.sql`.
The Desktop migration `20261006200000_ar_book_identity_verified_cache.sql` is
another copy of the same migration. Run only one copy, once. If you already
ran AR-book-identity-verified-cache.sql, the SQL step is complete; do not run
this repository copy again. Uploading it to GitHub does not execute it.

## Coordinated rollout

1. If the SQL step is still outstanding, paste the **entire** migration into
   Supabase's SQL Editor for the intended Marlow project and run it once.
   It creates an empty verified cache, preserves all legacy rows and
   service access, and revokes ordinary direct legacy reads. Unexpected
   state raises and rolls back. Do not rerun the old `ar_book_data.sql` or
   bypass a raised error. Already displayed legacy badges can remain in
   memory until Reader is reopened or the app restarted.
2. Update and commit these exact repository paths together:

   ```text
   package.json
   README.md
   scripts/sync-ar-data.mjs
   scripts/book-identity.mjs
   supabase/ar_book_matches_v2.sql
   .github/workflows/sync-ar-data.yml
   ```

   Keep folder paths. Root-level module/SQL copies are duplicates, not
   replacements for the files above. The hidden `.github` workflow must
   be updated too; edit the existing file separately if browser upload
   omits it. No pull request was created by Codex. Existing package
   contents and GitHub secrets are unchanged.
3. Let any already-running old sync finish. Scheduled v2 runs retain the
   six-hour cadence. In GitHub Actions, select **Sync AR BookFinder data**
   and **Run workflow**, with `sync_limit=1` and `debug=0` for the first
   small batch. Inspect any positive result's official full identity.
   A green run alone is not identity proof. The rotating batch may select
   a different book, so it need not check a particular reported title.
4. Install the rebuilt Marlow client using the same v2 identity rules.
   Missing schema, unverified data or unknown proof gives no quiz badge.
   Saved Reader work stays intact. This update needs no Edge function
   deployment, new secret or Realtime change.

Legacy wrong matches cannot be certified automatically. This migration
does not edit students' books, delete cache history or transfer old rows.
Codex has not run the importer or inspected live v2 cache rows.

## Performance and bounds

Cache keys include title, author and canonical ISBN-or-null as a JSON
tuple; separators in titles cannot collide. Keyset pagination avoids the
default 1,000-row API ceiling. Existing confirmed identities are rechecked
after 90 days; `unverified` after 30 days. Each run processes at most 25
identities, separated by polite delays. The bounded candidate window rotates each six-hour slot to avoid a fixed
failed prefix blocking later work; changing inventories are not a durable
fair queue. A single workflow concurrency
group and original-date conditional updates avoid normal overlapping
writers; they are not a full transactional source/version lock.

Admission bounds: 100,000 inventory rows per table, 20,000 distinct valid
identities, 100 search results / 5 pages, 10 exact-title detail candidates,
256 publisher ISBN rows / 200 distinct canonical ISBNs, 4 MiB per database
response, 32 MiB accepted inventory per table, 128 KiB per inventory row,
30-second database requests, 1,000 UTF-16 characters per title/author. Larger
or unsupported work defers intact. These are computational limits, not
measured run time or guarantees of catalog completeness.

This is a source-reviewed proposal. Current official fields were observed
in a browser on October 6, 2026; the new importer itself has not been run
against the site or database. Site changes fail closed. Requested diagnostic artifacts contain only bounded
route/field-availability flags, with no raw entered title/author/ISBN, HTML,
screenshot, cookie or session URL. Existing package
versions/install method are preserved in this bounded repair. Read the
provider's terms separately before continuing automated access at scale.
