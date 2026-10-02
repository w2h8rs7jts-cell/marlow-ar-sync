// Nightly sync: looks up Accelerated Reader data for books Marlow
// students are reading, and writes it to the `ar_book_data` table in
// Supabase (see ../supabase/ar_book_data.sql). The Marlow app never
// talks to arbookfind.com directly -- it only ever reads this table.
//
// HONEST CAVEAT, matching this project's own "least-certain file, not
// build-tested" convention: arbookfind.com has no public API. This
// drives a real headless browser (Playwright) against their actual
// search form rather than guessing at hidden ASP.NET POST fields
// (__VIEWSTATE etc.), the same approach prior open-source AR-lookup
// tools used with PhantomJS -- but the exact CSS selectors below
// (SEARCH_INPUT_SELECTORS / RESULT_LINK_SELECTOR / detail-page
// labels) were written from arbookfind's publicly documented search
// fields, NOT verified against the live rendered page from inside
// this sandbox (outbound access to arbookfind.com is blocked here).
// Expect the FIRST real run in GitHub Actions to need a selector
// adjustment pass -- run with SYNC_DEBUG=1 and a small SYNC_LIMIT to
// iterate quickly, and keep an eye on the workflow's uploaded
// screenshot/html artifacts on failure (see workflow file) rather
// than guessing blind.
//
// Also worth being direct about: arbookfind's own terms of use are
// not written with "an automated nightly job" in mind. This script
// runs the lookup as a small, rate-limited, incremental batch (new/
// unmatched books only, never a full re-crawl -- see MAX_LOOKUPS_PER_RUN
// and the staleness check below) specifically to stay as close to
// "occasional single lookup" in spirit as something automated can.
// That's a mitigation, not a guarantee of compliance -- worth a human
// decision, not just an engineering one, before this runs unattended
// long-term.

import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { mkdir, writeFile } from "node:fs/promises";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MAX_LOOKUPS_PER_RUN = Number(process.env.SYNC_LIMIT ?? 25);
const MIN_DELAY_MS = 2500;
const MAX_DELAY_MS = 4500;
// A confirmed "no AR quiz for this book" is re-checked occasionally
// (a quiz can be added to arbookfind after this first ran), but not
// every single night -- that would mean re-requesting every book that
// has ever come back empty, forever, which defeats the whole point of
// only scraping what's new/changed.
const MAX_NOT_FOUND_AGE_DAYS = 30;
const DEBUG = process.env.SYNC_DEBUG === "1";

function normalizeKey(title, author) {
  const t = (title ?? "").trim().toLowerCase();
  const a = (author ?? "").trim().toLowerCase();
  return `${t}|${a}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay() {
  return MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
}

async function fetchBooksNeedingLookup(supabase) {
  // reader_books has no shared "catalog" id -- every row is one
  // student's own copy of a book, so distinct title/author pairs are
  // pulled directly from it and deduplicated here in JS (a `distinct`
  // query across two text columns via supabase-js's query builder is
  // awkward; this table is small enough that pulling title/author
  // alone and deduplicating client-side is simpler and plenty fast).
  const { data: readerBooks, error: readerBooksError } = await supabase
    .from("reader_books")
    .select("title, author");

  if (readerBooksError) {
    throw new Error(`Failed to read reader_books: ${readerBooksError.message}`);
  }

  const seen = new Map();
  for (const row of readerBooks ?? []) {
    if (!row.title || !row.title.trim()) continue;
    const key = normalizeKey(row.title, row.author);
    if (!seen.has(key)) {
      seen.set(key, { title: row.title.trim(), author: (row.author ?? "").trim(), lookupKey: key });
    }
  }

  const { data: existing, error: existingError } = await supabase
    .from("ar_book_data")
    .select("lookup_key, match_status, last_checked_at");

  if (existingError) {
    throw new Error(`Failed to read ar_book_data: ${existingError.message}`);
  }

  const existingByKey = new Map((existing ?? []).map((row) => [row.lookup_key, row]));
  const cutoff = Date.now() - MAX_NOT_FOUND_AGE_DAYS * 24 * 60 * 60 * 1000;

  const needsLookup = [];
  for (const book of seen.values()) {
    const existingRow = existingByKey.get(book.lookupKey);
    if (!existingRow) {
      needsLookup.push(book);
      continue;
    }
    if (existingRow.match_status === "not_found") {
      const lastChecked = new Date(existingRow.last_checked_at).getTime();
      if (lastChecked < cutoff) {
        needsLookup.push(book);
      }
    }
    // match_status === "matched" rows are never re-queued -- a book's
    // AR quiz number/ATOS level don't change once published.
  }

  return needsLookup;
}

// Several plausible selectors tried in order, rather than one guessed
// id -- arbookfind is an ASP.NET WebForms site, which typically
// generates long auto-numbered control ids (e.g.
// "ctl00_ContentPlaceHolder1_txtKeyword") that are brittle to guess
// and can change between deploys. Role/placeholder-based locators are
// more resilient to that than a raw CSS id would be.
//
// Confirmed against a live screenshot of the real page (2026-10-01):
// none of these actually match. The Quick Search box on
// default.aspx is a plain <input> with NO type attribute at all (so
// `input[type=text]` never matches it) and no placeholder or
// accessible label (so the role/placeholder candidates miss too).
// Kept as fast first attempts in case a future page redesign adds
// one of these, but findSearchInput() always has the width-based
// fallback below to fall through to.
const SEARCH_INPUT_CANDIDATES = [
  { role: "textbox", name: /title|keyword|quick search/i },
  { placeholder: /title|keyword|author/i },
  { css: "input[type=text]" },
];

async function findSearchInput(page) {
  for (const candidate of SEARCH_INPUT_CANDIDATES) {
    try {
      let locator;
      if (candidate.role) {
        locator = page.getByRole(candidate.role, { name: candidate.name });
      } else if (candidate.placeholder) {
        locator = page.getByPlaceholder(candidate.placeholder);
      } else if (candidate.css) {
        locator = page.locator(candidate.css).first();
      }
      if (locator && (await locator.count()) > 0) {
        return locator.first();
      }
    } catch {
      // Try the next candidate.
    }
  }

  // Fallback: the page also has a second, narrow "Enter Keycode" text
  // input in the sidebar, so "just grab the first text input" isn't
  // safe -- it can land on the wrong box. Instead, collect every
  // visible plain-text input (explicit type="text"/"search", or no
  // type attribute at all, which defaults to text) and pick the
  // widest one: the Quick Search box spans most of the content
  // column while the keycode box is a few characters wide.
  try {
    const plainTextInputs = page.locator('input:not([type]), input[type="text"], input[type="search"]');
    const count = await plainTextInputs.count();
    let widest = null;
    let widestWidth = 0;
    for (let i = 0; i < count; i++) {
      const el = plainTextInputs.nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      const box = await el.boundingBox().catch(() => null);
      if (box && box.width > widestWidth) {
        widestWidth = box.width;
        widest = el;
      }
    }
    return widest;
  } catch {
    return null;
  }
}

async function lookupBook(page, book) {
  await page.goto("https://www.arbookfind.com/Default.aspx", { waitUntil: "domcontentloaded" });

  const searchInput = await findSearchInput(page);
  if (!searchInput) {
    if (DEBUG) console.log(`[sync-ar-data] No search input found for "${book.title}" -- dumping page HTML length: ${(await page.content()).length}`);
    return { status: "not_found" };
  }

  const query = book.author ? `${book.title} ${book.author}` : book.title;
  await searchInput.fill(query);

  // This is an ASP.NET WebForms postback page -- pressing Enter only
  // submits if the input happens to sit inside a <form> with exactly
  // one submit-triggering control, which isn't guaranteed here (the
  // page also has the separate Keycode "Go" button). Click the
  // visible "Search" button directly instead, which is what an actual
  // visitor does; fall back to Enter only if no such button is found.
  const searchButton = page.getByRole("button", { name: /^search$/i }).first();
  if ((await searchButton.count()) > 0) {
    await searchButton.click();
  } else {
    await searchInput.press("Enter");
  }
  await page.waitForLoadState("networkidle").catch(() => {});

  // First result row's title link -- arbookfind's results list
  // renders each match as a row with the title as a link into the
  // book's detail page. `getByRole("link")` scoped to something
  // title-ish is more resilient than a positional CSS selector into
  // an auto-generated results grid.
  const firstResultLink = page.getByRole("link", { name: new RegExp(escapeRegExp(book.title.slice(0, 20)), "i") }).first();
  if ((await firstResultLink.count()) === 0) {
    return { status: "not_found" };
  }

  await firstResultLink.click();
  await page.waitForLoadState("networkidle").catch(() => {});

  const bodyText = await page.locator("body").innerText();
  const quizMatch = bodyText.match(/Quiz\s*No\.?:?\s*(\d+)/i);
  const atosMatch = bodyText.match(/ATOS\s*Book\s*Level:?\s*([\d.]+)/i);
  const interestMatch = bodyText.match(/Interest\s*Level:?\s*([A-Za-z0-9\-+ ]+?)(?:\n|$)/i);
  const pointsMatch = bodyText.match(/AR\s*Points:?\s*([\d.]+)/i);

  if (!quizMatch) {
    if (DEBUG) console.log(`[sync-ar-data] Opened a detail page for "${book.title}" but found no AR Quiz No. -- treating as not_found.`);
    return { status: "not_found" };
  }

  const matchedTitle = (await page.locator("h1, h2").first().innerText().catch(() => null)) ?? book.title;

  return {
    status: "matched",
    arQuizNumber: Number(quizMatch[1]),
    atosBookLevel: atosMatch ? Number(atosMatch[1]) : null,
    interestLevel: interestMatch ? interestMatch[1].trim() : null,
    arPoints: pointsMatch ? Number(pointsMatch[1]) : null,
    matchedTitle: matchedTitle.trim(),
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Written only on a lookup failure/miss when DEBUG is on, or always
// for the FIRST failure in a run even without DEBUG (so a totally
// broken selector doesn't silently produce 25 empty diagnostics-free
// failures before anyone notices) -- a screenshot + the raw page HTML
// of wherever the browser actually was, uploaded by the workflow as a
// build artifact. See this file's top-of-file caveat on why this
// exists: the search/result selectors are unverified against the live
// site from inside the sandbox this was written in.
async function saveDiagnostics(page, label) {
  try {
    await mkdir("diagnostics", { recursive: true });
    const safeLabel = label.replace(/[^a-z0-9-]/gi, "_").slice(0, 60);
    await page.screenshot({ path: `diagnostics/${safeLabel}.png`, fullPage: true });
    await writeFile(`diagnostics/${safeLabel}.html`, await page.content());
  } catch (diagnosticError) {
    console.error(`[sync-ar-data] Failed to save diagnostics for "${label}": ${diagnosticError.message}`);
  }
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (see .github/workflows/sync-ar-data.yml).");
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const candidates = await fetchBooksNeedingLookup(supabase);
  const batch = candidates.slice(0, MAX_LOOKUPS_PER_RUN);

  console.log(`[sync-ar-data] ${candidates.length} book(s) need a lookup; processing ${batch.length} this run (limit ${MAX_LOOKUPS_PER_RUN}).`);

  if (batch.length === 0) {
    console.log("[sync-ar-data] Nothing to do.");
    return;
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ userAgent: "Mozilla/5.0 (compatible; MarlowARSync/1.0; +https://github.com/w2h8rs7jts-cell/marlow-ar-sync)" });

  let matched = 0;
  let notFound = 0;
  let failed = 0;
  let diagnosticsSaved = false;

  for (const [index, book] of batch.entries()) {
    try {
      console.log(`[sync-ar-data] (${index + 1}/${batch.length}) Looking up "${book.title}"${book.author ? ` by ${book.author}` : ""}...`);
      const result = await lookupBook(page, book);

      if (result.status === "not_found" && !diagnosticsSaved) {
        // Captured on the FIRST not_found/failure of the run even
        // without SYNC_DEBUG -- a real "no AR quiz for this book" and
        // a broken selector both produce not_found, and without this
        // the two are indistinguishable from the job log alone.
        await saveDiagnostics(page, `first-not-found-${book.title}`);
        diagnosticsSaved = true;
      }

      const row = {
        lookup_key: book.lookupKey,
        title: book.title,
        author: book.author,
        match_status: result.status,
        last_checked_at: new Date().toISOString(),
        ar_quiz_number: result.arQuizNumber ?? null,
        atos_book_level: result.atosBookLevel ?? null,
        interest_level: result.interestLevel ?? null,
        ar_points: result.arPoints ?? null,
        matched_title: result.matchedTitle ?? null,
      };

      const { error: upsertError } = await supabase.from("ar_book_data").upsert(row, { onConflict: "lookup_key" });
      if (upsertError) {
        console.error(`[sync-ar-data] Failed to upsert "${book.title}": ${upsertError.message}`);
        failed++;
        continue;
      }

      if (result.status === "matched") {
        matched++;
        console.log(`[sync-ar-data]   -> matched, AR Quiz No. ${result.arQuizNumber}`);
      } else {
        notFound++;
        console.log(`[sync-ar-data]   -> no AR quiz found`);
      }
    } catch (error) {
      failed++;
      console.error(`[sync-ar-data] Lookup failed for "${book.title}": ${error.message}`);
      await saveDiagnostics(page, `error-${book.title}`);
    }

    if (index < batch.length - 1) {
      await sleep(randomDelay());
    }
  }

  await browser.close();

  console.log(`[sync-ar-data] Done. matched=${matched} not_found=${notFound} failed=${failed}`);
}

main().catch((error) => {
  console.error("[sync-ar-data] Fatal error:", error);
  process.exitCode = 1;
});
