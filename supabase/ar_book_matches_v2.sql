-- NEW, manual coordinated rollout. Never run the old baseline again.
-- Creates an EMPTY strict cache; no legacy row is promoted, converted,
-- overwritten or deleted. Deploy rebuilt clients and merge the strict
-- importer after this transaction. Old clients lose unsafe AR reads.
begin;

do $preflight$
begin
  if to_regclass('public.reader_books') is null or not exists (
    select 1 from pg_attribute where attrelid='public.reader_books'::regclass
      and attname='isbn' and atttypid='text'::regtype and not attisdropped
  ) then raise exception 'Expected current reader_books ISBN schema is unavailable; no change made'; end if;
  if to_regclass('public.ar_book_data') is null then
    raise exception 'Expected existing AR cache is unavailable; inspect the deployed schema first';
  end if;
  if to_regclass('public.ar_book_matches_v2') is not null then
    raise exception 'AR v2 cache is already present; inspect its original migration rather than rerun';
  end if;
  if not has_table_privilege('service_role','public.ar_book_data','SELECT') then
    raise exception 'The existing sync service cannot read its retained legacy cache';
  end if;
end;
$preflight$;

create table public.ar_book_matches_v2 (
  id uuid not null unique default uuid_generate_v4(),
  lookup_key text primary key check (octet_length(lookup_key) between 1 and 16000),
  title text not null check (length(title) between 1 and 1000),
  author text not null check (length(author) between 1 and 1000),
  isbn text check (isbn is null or isbn ~ '^97[89][0-9]{10}$'),
  match_status text not null check (match_status in ('matched','unverified')),
  verification_policy text not null check (verification_policy='arIdentity.v2'),
  ar_quiz_number integer check (ar_quiz_number between 1 and 999999999),
  atos_book_level numeric check (atos_book_level between 0 and 20),
  interest_level text check (length(interest_level) <= 80),
  ar_points numeric check (ar_points between 0 and 1000),
  matched_title text check (length(matched_title) between 1 and 1000),
  matched_author text check (length(matched_author) between 1 and 1000),
  matched_isbns text[] not null default '{}' check (cardinality(matched_isbns) <= 200 and array_position(matched_isbns, null::text) is null and (cardinality(matched_isbns)=0 or array_to_string(matched_isbns,'|') ~ '^97[89][0-9]{10}([|]97[89][0-9]{10})*$')),
  source_url text check (length(source_url) <= 2048),
  source_language text,
  source_quiz_type text,
  last_checked_at timestamptz not null check (last_checked_at > '1970-01-01'::timestamptz and isfinite(last_checked_at)),
  created_at timestamptz not null default now(),
  constraint ar_v2_evidence_shape check (
    ((match_status='matched' and ar_quiz_number is not null and matched_title is not null
      and matched_author is not null and source_url is not null
      and source_language='EN' and source_quiz_type='ReadingPractice'
      and (isbn is null or isbn=any(matched_isbns)))
    or
    (match_status='unverified' and ar_quiz_number is null and atos_book_level is null
      and interest_level is null and ar_points is null and matched_title is null
      and matched_author is null and cardinality(matched_isbns)=0
      and source_url is null and source_language is null and source_quiz_type is null)) is true
  )
);

alter table public.ar_book_matches_v2 enable row level security;
revoke all on public.ar_book_matches_v2 from public, anon, authenticated;
grant select on public.ar_book_matches_v2 to authenticated;
grant select, insert, update on public.ar_book_matches_v2 to service_role;
create policy ar_book_matches_v2_authenticated_read on public.ar_book_matches_v2
  for select to authenticated using (match_status='matched');

-- The old prefix/first-result rows cannot safely be shown by older
-- applications. Preserve ALL their bytes for service/admin review,
-- but close direct ordinary reads; there is no legacy fallback in v2.
revoke select on public.ar_book_data from public, anon, authenticated restrict;

do $postflight$
begin
  if has_any_column_privilege('authenticated','public.ar_book_data','SELECT')
    or has_any_column_privilege('anon','public.ar_book_data','SELECT') then
    raise exception 'Inherited/column legacy reads remain; transaction rolled back for review';
  end if;
  if not has_table_privilege('service_role','public.ar_book_data','SELECT')
    or not has_table_privilege('service_role','public.ar_book_matches_v2','SELECT')
    or not has_table_privilege('service_role','public.ar_book_matches_v2','INSERT')
    or not has_table_privilege('service_role','public.ar_book_matches_v2','UPDATE')
    or not has_table_privilege('authenticated','public.ar_book_matches_v2','SELECT')
    or has_any_column_privilege('anon','public.ar_book_matches_v2','SELECT')
    or has_table_privilege('authenticated','public.ar_book_matches_v2','INSERT,UPDATE,DELETE,TRUNCATE') then
    raise exception 'Unexpected AR cache execution path; transaction rolled back';
  end if;
end;
$postflight$;
notify pgrst, 'reload schema';
commit;
