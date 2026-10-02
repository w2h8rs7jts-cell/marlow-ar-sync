-- Run this once against the live Marlow Supabase project (SQL Editor),
-- then `NOTIFY pgrst, 'reload schema';` afterward -- same pattern as
-- every other migration in the main StudyBridge/Marlow repo's
-- overnight_migration scripts. Written with `if not exists` throughout
-- so a second accidental run is harmless.
--
-- WHY A SEPARATE TABLE, NOT A COLUMN ON reader_books:
-- `reader_books` is one row PER STUDENT PER BOOK (student_id is a
-- foreign key on every row) -- there's no shared, canonical "this is
-- the book itself" record two different students reading the same
-- title currently share. Putting AR columns directly on reader_books
-- would mean looking up (and storing) the exact same AR data
-- separately for every single student who happens to read the same
-- book, which wastes lookups and risks the two copies drifting if one
-- gets refreshed and the other doesn't.
--
-- This table is keyed by a normalized "title|author" string instead
-- (lowercased, trimmed -- see sync script's own normalizeKey()) so
-- it's shared across every student's reader_books row for the same
-- book. The app queries this table by the same normalized key it
-- already has (title + author are already on reader_books) rather
-- than needing an ISBN, which nothing in this app currently captures.
create table if not exists ar_book_data (
  id uuid primary key default uuid_generate_v4(),
  -- lower(trim(title)) || '|' || lower(trim(author)) -- see the sync
  -- script's normalizeKey() for the exact algorithm; must match
  -- exactly or lookups silently miss.
  lookup_key text not null unique,
  title text not null,
  author text not null default '',
  ar_quiz_number integer,
  atos_book_level numeric,
  interest_level text,
  ar_points numeric,
  -- 'matched' | 'not_found' -- distinguishes "we looked and there's
  -- genuinely no AR quiz for this book" from "we haven't looked yet"
  -- (a row simply not existing). Lets the sync script skip re-checking
  -- a confirmed not_found every single night -- see MAX_NOT_FOUND_AGE_DAYS
  -- in the sync script for the re-check cadence that still applies.
  match_status text not null default 'not_found' check (match_status in ('matched', 'not_found')),
  -- The exact title arbookfind matched against, when matched -- lets a
  -- human sanity-check a fuzzy title-only match later without needing
  -- to re-run the lookup.
  matched_title text,
  last_checked_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists ar_book_data_lookup_key_idx on ar_book_data (lookup_key);

-- Read-only to the app's normal authenticated users -- this table is
-- written ONLY by the sync job's service-role key (see
-- .github/workflows/sync-ar-data.yml), never by the app itself, same
-- "only a trusted server path writes here" shape as `notifications`/
-- `misconduct_reports` in the main schema.
alter table ar_book_data enable row level security;

drop policy if exists "ar_book_data_select_authenticated" on ar_book_data;
create policy "ar_book_data_select_authenticated"
  on ar_book_data for select
  to authenticated
  using (true);

-- RLS alone isn't enough -- Postgres also requires the base table
-- grant before a role can touch the table at all (RLS policies only
-- filter rows once that base grant exists; without it you get a flat
-- "permission denied for table" error instead of an empty/filtered
-- result). New projects normally get this for free via Supabase's
-- default-privilege setup for objects created through the SQL editor,
-- but that didn't take here, so it's granted explicitly instead of
-- relying on it again:
--   - service_role: this job's own key. It already bypasses RLS, but
--     still needs the base grant to read/write at all.
--   - authenticated: matches the select policy above, for if/when the
--     Marlow app itself reads this table directly.
grant select, insert, update on ar_book_data to service_role;
grant select on ar_book_data to authenticated;

notify pgrst, 'reload schema';
