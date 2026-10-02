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

async function findSearchButton(page) {
  const roleButton = page.getByRole("button", { name: /search/i }).first();
  if ((await roleButton.count().catch(() => 0)) > 0) {
    return roleButton;
  }

  try {
    const candidates = page.locator('button, input[type="submit"], input[type="button"]');
    const count = await candidates.count();
    for (let i = 0; i < count; i++) {
      const el = candidates.nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      const value = await el.getAttribute("value").catch(() => null);
      const text = value ?? (await el.innerText().catch(() => ""));
      if (/^\s*search\s*$/i.test(text ?? "")) {
        return el;
      }
    }
  } catch {
    // fall through to null
  }
  return null;
}

// First-ever visit in a session shows a "Please tell us who you are"
// interstitial (Student/Parent/Teacher/Librarian radio buttons + a
// Submit button) before the real Default.aspx content -- confirmed
// from a live screenshot. It's presumably gated by a cookie/session
// var that only gets set once that's answered, which is why a script
// that never answers it can keep landing back on some variant of it
// instead of ever reaching the search box. Picks "Teacher" somewhat
// arbitrarily -- the gate doesn't appear to change what's searchable,
// just which role-specific framing/ads show afterward.
async function passWelcomeGateIfPresent(page) {
  const roleRadio = page.getByRole("radio", { name: /teacher|parent|student|librarian/i }).first();
  const hasRoleGate = (await roleRadio.count().catch(() => 0)) > 0;
  if (!hasRoleGate) return false;

  try {
    await roleRadio.check({ force: true });
    const submitButton = page.getByRole("button", { name: /submit/i }).first();
    if ((await submitButton.count()) > 0) {
      await submitButton.click();
    } else {
      // Fall back to pressing Enter in case Submit isn't a real
      // <button>/role=button element on this page.
      await page.keyboard.press("Enter");
    }
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

async function dismissCookieBannerIfPresent(page) {
  const okButton = page.getByRole("button", { name: /^ok$/i }).first();
  if ((await okButton.count().catch(() => 0)) > 0) {
    await okButton.click().catch(() => {});
  }
}

async function lookupBook(page, book) {
  await page.goto("https://www.arbookfind.com/Default.aspx", { waitUntil: "domcontentloaded" });
  // The Quick Search box (or, on a first visit, the welcome gate) may
  // be built by client-side JS after domcontentloaded fires rather
  // than present in the initial HTML -- give it a beat to show up (or
  // at least for the network to go quiet) before looking for either.
  await page.waitForSelector("input", { timeout: 8000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});

  await dismissCookieBannerIfPresent(page);
  const passedGate = await passWelcomeGateIfPresent(page);
  if (passedGate) {
    await dismissCookieBannerIfPresent(page);
  }

  // Confirmed directly from the live page's markup (via browser
  // DevTools, since this sandbox can't reach arbookfind.com itself):
  // the Quick Search box is
  // <input type="text" id="ctl00_ContentPlaceHolder1_txtKeyWords">
  // and its Search button is
  // <input type="submit" id="ctl00_ContentPlaceHolder1_btnDoIt" value="Search">
  // with no onclick override -- a plain native form submit. Try the
  // real ID directly first; fall back to the heuristic finder in case
  // Renaissance ever changes these generated ids.
  const SEARCH_INPUT_ID = "#ctl00_ContentPlaceHolder1_txtKeyWords";
  const SEARCH_BUTTON_ID = "#ctl00_ContentPlaceHolder1_btnDoIt";

  let searchInput = page.locator(SEARCH_INPUT_ID).first();
  if ((await searchInput.count().catch(() => 0)) === 0) {
    searchInput = await findSearchInput(page);
  }
  if (!searchInput) {
    // Log what's actually on the page instead of just its byte count
    // -- this prints straight to the job log, which is readable
    // without downloading the diagnostics artifact. Every <input> on
    // the page (plus any inside iframes, in case the search form is
    // embedded) with the attributes/size that would make it match (or
    // not match) the selectors above.
    const describeInputs = async (frame, frameLabel) => {
      try {
        return await frame.evaluate((label) => {
          return Array.from(document.querySelectorAll("input")).map((el) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return `${label} <input type=${JSON.stringify(el.getAttribute("type"))} id=${JSON.stringify(el.id)} name=${JSON.stringify(el.name)} placeholder=${JSON.stringify(el.placeholder)} w=${Math.round(rect.width)} h=${Math.round(rect.height)} display=${style.display} visibility=${style.visibility}>`;
          });
        }, frameLabel);
      } catch (evalError) {
        return [`${frameLabel} <failed to inspect: ${evalError.message}>`];
      }
    };

    const lines = [];
    for (const frame of page.frames()) {
      const label = frame === page.mainFrame() ? "[main]" : `[frame ${frame.url()}]`;
      lines.push(...(await describeInputs(frame, label)));
    }
    console.log(`[sync-ar-data] No search input found for "${book.title}" -- page title: ${JSON.stringify(await page.title())}, url: ${page.url()}, HTML length: ${(await page.content()).length}, ${page.frames().length} frame(s):`);
    if (lines.length === 0) {
      console.log("[sync-ar-data]   (no <input> elements found anywhere on the page)");
    } else {
      for (const line of lines) console.log(`[sync-ar-data]   ${line}`);
    }
    return { status: "not_found" };
  }

  const query = book.author ? `${book.title} ${book.author}` : book.title;
  await searchInput.click();
  await searchInput.fill(query);

  // Every prior attempt (Enter, a heuristically-located button click)
  // failed to submit at all, on both the search box and a plain
  // native <input type="submit"> with no onclick override -- while
  // the exact same searches worked fine manually. That combination
  // pointed at bot detection rather than a selector problem (see the
  // User-Agent/navigator.webdriver fix in main()), not at Enter vs.
  // click being the wrong mechanism. Click the real, confirmed Search
  // button by its actual id now; Enter is kept only as a fallback.
  let searchButton = page.locator(SEARCH_BUTTON_ID).first();
  if ((await searchButton.count().catch(() => 0)) === 0) {
    searchButton = await findSearchButton(page);
  }
  if (searchButton) {
    await searchButton.click();
  } else {
    await searchInput.press("Enter");
  }
  await page.waitForLoadState("networkidle").catch(() => {});

  if (/Default\.aspx$/i.test(page.url()) && /quick search/i.test(await page.title())) {
    console.log(`[sync-ar-data] Search button click didn't navigate for "${book.title}" -- trying Enter as a fallback.`);
    await searchInput.press("Enter");
    await page.waitForLoadState("networkidle").catch(() => {});
  }

  if (/Default\.aspx$/i.test(page.url()) && /quick search/i.test(await page.title())) {
    // Still on the homepage after trying to search -- the submit
    // itself silently failed rather than the search returning zero
    // results (a real empty result set lands on a results page that
    // says "0 of 0", not back on the Quick Search tab).
    console.log(`[sync-ar-data] Search for "${book.title}" didn't navigate away from the Quick Search page -- the submit likely didn't fire.`);
  }

  // First result row's title link -- arbookfind's results list
  // renders each match as a row with the title as a link into the
  // book's detail page. `getByRole("link")` scoped to something
  // title-ish is more resilient than a positional CSS selector into
  // an auto-generated results grid.
  const firstResultLink = page.getByRole("link", { name: new RegExp(escapeRegExp(book.title.slice(0, 20)), "i") }).first();
  if ((await firstResultLink.count()) === 0) {
    // Log what links actually exist on the results page -- either the
    // search genuinely returned nothing, or the results list renders
    // link text that doesn't contain the book's own title the way
    // this regex assumes (e.g. truncated, or title+author combined
    // differently).
    const allLinkTexts = await page
      .getByRole("link")
      .allInnerTexts()
      .catch(() => []);
    console.log(`[sync-ar-data] No result link matched "${book.title}" on the results page -- url: ${page.url()}, page title: ${JSON.stringify(await page.title())}, ${allLinkTexts.length} link(s) on page:`);
    for (const text of allLinkTexts.slice(0, 40)) {
      const trimmed = text.trim();
      if (trimmed) console.log(`[sync-ar-data]   link: ${JSON.stringify(trimmed)}`);
    }
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
    // Log a chunk of the actual detail-page text so a wrong label
    // format ("Quiz #" vs "Quiz No." etc.) is visible directly in the
    // job log instead of just being swallowed as not_found.
    console.log(`[sync-ar-data] Opened a detail page for "${book.title}" but found no AR Quiz No. -- url: ${page.url()}, page title: ${JSON.stringify(await page.title())}`);
    console.log(`[sync-ar-data]   body text (first 1500 chars): ${JSON.stringify(bodyText.slice(0, 1500))}`);
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

  // Every search attempt so far has failed to submit at all (not Enter,
  // not a direct click on a plain native <input type="submit"> with no
  // onclick override) despite the exact same searches working fine in
  // a real browser -- the self-identifying User-Agent below
  // ("compatible; MarlowARSync/1.0...", which looks exactly like a bot
  // announcing itself) was the prime suspect, since sites commonly
  // detect a non-browser UA and quietly serve/behave differently
  // without any visible error. Using a real browser UA instead, and
  // masking the most common headless-automation tell
  // (navigator.webdriver, which Playwright sets true by default and
  // some anti-bot JS checks for) via --disable-blink-features and an
  // init script.
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

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
