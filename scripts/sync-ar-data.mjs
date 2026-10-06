// Exact, conservative AR BookFinder verification. The old ar_book_data
// rows are preserved; no v1 match is copied or promoted into this cache.
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { mkdir, writeFile } from "node:fs/promises";
import { POLICY, normalizeText, canonicalISBN, requestedIdentity, confirmedDetail } from "./book-identity.mjs";

const LIMIT = Number(process.env.SYNC_LIMIT ?? 25);
const PAGE_SIZE = 500, MAX_ROWS = 100000, MAX_IDENTITIES = 20000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024, MAX_INVENTORY_BYTES = 32 * 1024 * 1024;
const MAX_RESULTS = 100, MAX_RESULT_PAGES = 5, MAX_DETAILS = 10;
const DAY = 86400000;
const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const politeDelay = () => pause(2500 + Math.random() * 2000);
const TABLE = "ar_book_matches_v2";
const PREFIX = "ctl00_ContentPlaceHolder1_";
const DETAIL = PREFIX + "ucBookDetail_";

// Keyset pagination avoids Supabase's default 1,000-row response ceiling.
// Bounds refuse the whole inventory rather than silently treating a
// truncated list as the complete set of known or checked books.
async function readPages(client, table, columns, cursor) {
  const rows = []; let after = null, retainedBytes = 0;
  while (true) {
    let query = client.from(table).select(columns).order(cursor, { ascending: true }).limit(PAGE_SIZE);
    if (after !== null) query = query.gt(cursor, after);
    const { data, error } = await query;
    if (error || !Array.isArray(data)) throw new Error(`Cannot read the complete ${table} inventory.`);
    if (data.length > PAGE_SIZE || rows.length + data.length > MAX_ROWS) throw new Error("Inventory exceeds the bounded sync capacity.");
    if (data.length === 0) return rows;
    for (const row of data) {
      if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("Unsupported inventory row.");
      const bytes = Buffer.byteLength(JSON.stringify(row), "utf8");
      retainedBytes += bytes;
      if (bytes > 128 * 1024 || retainedBytes > MAX_INVENTORY_BYTES) throw new Error("Inventory byte budget exceeded; no partial list was adopted.");
      if (typeof row[cursor] !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(row[cursor]) || (after !== null && row[cursor] <= after)) throw new Error("Inventory ordering changed; no lookup was started.");
      after = row[cursor]; rows.push(row);
    }
    // Continue even after a short page: a lower deployed row cap must
    // not be confused with a complete inventory. The next empty query
    // is the terminal observation under this service access.
  }
}

async function candidates(client) {
  // Table existence and privilege are checked BEFORE browser work. A
  // missing staged migration cannot fall back to the unsafe v1 writer.
  const existing = await readPages(client, TABLE, "id,lookup_key,match_status,verification_policy,last_checked_at", "id");
  const readers = await readPages(client, "reader_books", "id,title,author,isbn", "id");
  const known = new Map(existing.map(row => [row.lookup_key, row]));
  const unique = new Map(); let refused = 0;
  for (const row of readers) {
    if (!["id","title","author","isbn"].every(key => Object.hasOwn(row, key))) throw new Error("Incomplete reader identity projection; no absence was inferred.");
    const book = requestedIdentity(row.title, row.author ?? "", row.isbn);
    if (!book) { refused++; continue; }
    if (!unique.has(book.lookupKey)) unique.set(book.lookupKey, book);
    if (unique.size > MAX_IDENTITIES) throw new Error("Too many distinct book identities; no partial inventory was adopted.");
  }
  const now = Date.now(), needed = [];
  for (const book of unique.values()) {
    const prior = known.get(book.lookupKey);
    if (!prior) { needed.push({ ...book, prior: null }); continue; }
    if (prior.verification_policy !== POLICY || !["matched", "unverified"].includes(prior.match_status)) throw new Error("Unknown saved verification contract; originals were preserved.");
    if (typeof prior.last_checked_at !== "string" || prior.last_checked_at.length > 100) throw new Error("Unknown verification date encoding.");
    const date = Date.parse(prior.last_checked_at);
    if (!Number.isFinite(date) || date <= 0 || date > now + 5 * 60000) throw new Error("Unknown verification date; originals were preserved.");
    // Recheck confirmed matches too: changed markup and mistaken prior
    // confirmations must not live forever. Cache hits remain immediate.
    const ttl = (prior.match_status === "matched" ? 90 : 30) * DAY;
    if (now - date >= ttl) needed.push({ ...book, prior });
  }
  return { needed, refused };
}

async function visibleOne(page, selector) {
  const locator = page.locator(selector);
  if (await locator.count() !== 1 || !await locator.isVisible()) throw new Error("Official AR field is unavailable or ambiguous.");
  return locator;
}

async function textField(page, suffix, required = true) {
  const locator = page.locator("#" + DETAIL + suffix);
  const count = await locator.count();
  if (count === 0 && !required) return null;
  if (count !== 1 || !await locator.isVisible()) throw new Error("Official detail evidence is unavailable or ambiguous.");
  const text = (await locator.innerText()).trim();
  if (text.length > 2048 || (required && !text)) throw new Error("Official detail evidence is unsupported.");
  return text || null;
}

function officialDetailURL(raw) {
  try {
    const url = new URL(raw);
    const quiz = url.searchParams.getAll("q"), language = url.searchParams.getAll("l");
    if (url.protocol !== "https:" || !["www.arbookfind.com", "arbookfind.com"].includes(url.hostname) || url.port || url.username || url.password || url.pathname.toLowerCase() !== "/bookdetail.aspx" || quiz.length !== 1 || !/^[1-9]\d{0,8}$/.test(quiz[0]) || language.length !== 1 || language[0] !== "EN") return null;
    return { url: url.href, quiz: Number(quiz[0]), stableURL: `https://www.arbookfind.com/bookdetail.aspx?q=${quiz[0]}&l=EN` };
  } catch { return null; }
}

async function search(page, book) {
  await page.goto("https://www.arbookfind.com/advanced.aspx", { waitUntil: "domcontentloaded" });
  const welcome = page.locator("#radParent");
  if (await welcome.count() === 1 && await welcome.isVisible()) {
    await welcome.check();
    await (await visibleOne(page, "#btnSubmitUserType")).click();
    await page.waitForLoadState("domcontentloaded");
  }
  const cookie = page.locator("#cn-accept-cookie");
  if (await cookie.count() === 1 && await cookie.isVisible()) await cookie.click();
  // Current official Advanced Search fields observed 2026-10-06.
  // No widest-input, first-link, substring or quick-search fallback.
  await (await visibleOne(page, "#" + PREFIX + "txtTitle")).fill(book.title);
  await (await visibleOne(page, "#" + PREFIX + "txtAuthor")).fill(book.author);
  await (await visibleOne(page, "#" + PREFIX + "txtISBN")).fill(book.isbn ?? "");
  await (await visibleOne(page, "#" + PREFIX + "lstQuizType")).selectOption({ label: "Reading Practice" });
  await (await visibleOne(page, "#" + PREFIX + "lstLanguage")).selectOption({ label: "English" });
  await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }), (await visibleOne(page, "#" + PREFIX + "btnDoIt")).click()]);
  const noResults = page.locator("#" + PREFIX + "lblSearchResultFailedLabel");
  if (await noResults.count() === 1 && await noResults.isVisible() && (await noResults.innerText()).trim() === "No results found.") return [];
  const urls = new Map(); let seenRows = 0, expectedTotal = null;
  for (let p = 0; p < MAX_RESULT_PAGES; p++) {
    const summary = (await (await visibleOne(page, "#" + PREFIX + "ucSearchResultsHeader_lblResultSummary")).innerText()).trim();
    const paging = (await (await visibleOne(page, "#" + PREFIX + "ucSeachResults_lblResultsSummaryTop")).innerText()).trim();
    const range = summary.match(/^Titles?\s+(\d+)\s*-\s*(\d+)\s+of\s+(\d+)$/);
    const position = paging.match(/^Page\s+(\d+)\s+of\s+(\d+)$/);
    if (!range || !position) throw new Error("Search completion evidence is unknown.");
    const [start, end, total] = range.slice(1).map(Number), [current, pages] = position.slice(1).map(Number);
    if (![start,end,total,current,pages].every(Number.isSafeInteger) || total < 1 || total > MAX_RESULTS || start !== seenRows + 1 || end < start || end > total || current !== p + 1 || pages !== Math.ceil(total / 20) || (expectedTotal !== null && expectedTotal !== total)) throw new Error("Search range changed or exceeded the bounded complete search.");
    expectedTotal = total;
    const grid = await visibleOne(page, "#" + PREFIX + "ucSeachResults_lblQuizzes");
    const links = await grid.locator('a[id="book-title"]').evaluateAll(elements => elements.map(el => ({ text: el.innerText, href: el.href })));
    if (links.length === 0 || links.length > 20 || links.length !== end - start + 1) throw new Error("Search results could not be verified.");
    seenRows += links.length;
    if (seenRows > MAX_RESULTS) throw new Error("Search is too broad; no partial-page match was accepted.");
    for (const link of links) {
      const parsed = officialDetailURL(link.href);
      if (!parsed || typeof link.text !== "string" || link.text.length > 1000) throw new Error("Unexpected search result evidence.");
      if (normalizeText(link.text) === normalizeText(book.title)) urls.set(parsed.quiz, parsed);
    }
    const next = page.locator("#" + PREFIX + "ucSeachResults_btnNextPageTop");
    if (await next.count() !== 1 || !await next.isVisible()) throw new Error("Search pagination is unknown.");
    const disabled = await next.getAttribute("disabled"), href = await next.getAttribute("href");
    if (current === pages) {
      if (seenRows !== total || disabled === null || href !== null) throw new Error("The complete final result page was not proven.");
      return [...urls.values()];
    }
    if (disabled !== null || !await next.isEnabled() || href !== "javascript:__doPostBack('ctl00$ContentPlaceHolder1$ucSeachResults$btnNextPageTop','')") throw new Error("Next-page evidence is unsupported.");
    if (p === MAX_RESULT_PAGES - 1) throw new Error("Search is too broad; no partial-page match was accepted.");
    await politeDelay();
    await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }), next.click()]);
  }
  throw new Error("Search pagination was incomplete.");
}

function optionalNumber(text, maximum) {
  if (text === null) return null;
  if (!/^\d+(?:\.\d+)?$/.test(text)) throw new Error("Unsupported AR numeric evidence.");
  const number = Number(text);
  if (!Number.isFinite(number) || number < 0 || number > maximum) throw new Error("Unsupported AR numeric evidence.");
  return number;
}

async function detail(page, candidate) {
  await page.goto(candidate.url, { waitUntil: "domcontentloaded" });
  const actual = officialDetailURL(page.url());
  if (!actual || actual.quiz !== candidate.quiz) throw new Error("Detail page changed identity.");
  const title = await textField(page, "lblBookTitle"), author = await textField(page, "lblAuthor");
  const quizText = await textField(page, "lblQuizNumber"), language = await textField(page, "lblLanguageCode");
  const availability = await textField(page, "lblQuizStatusLabel");
  if (!/^[1-9]\d{0,8}$/.test(quizText) || Number(quizText) !== candidate.quiz || title.length > 1000 || author.length > 1000) throw new Error("Contradictory official quiz identity.");
  const table = await visibleOne(page, "#" + DETAIL + "tblPublisherTable");
  const publisherRows = await table.locator("tr").evaluateAll(rows => rows.map(row => Array.from(row.querySelectorAll("th,td")).map(cell => cell.innerText.trim())));
  if (publisherRows.length < 1 || publisherRows.length > 257 || publisherRows[0].length !== 5 || publisherRows[0][2] !== "ISBN") throw new Error("Official ISBN table is unsupported.");
  const isbns = new Set();
  for (const row of publisherRows.slice(1)) {
    if (row.length !== 5) throw new Error("Official ISBN row is unsupported.");
    const isbn = canonicalISBN(row[2]);
    if (!isbn) throw new Error("Official ISBN evidence is unavailable or invalid.");
    isbns.add(isbn);
    if (isbns.size > 200) throw new Error("Official ISBN evidence exceeds the client contract.");
  }
  const interest = await textField(page, "lblInterestLevel", false);
  if (interest !== null && interest.length > 80) throw new Error("Official interest-level evidence is unsupported.");
  return { title, author, quiz: candidate.quiz, language, quizTypes: availability.split(",").map(s => s.trim()), isbns: [...isbns].sort(), sourceURL: actual.stableURL,
    atos: optionalNumber(await textField(page, "lblBookLevel", false), 20), interest, points: optionalNumber(await textField(page, "lblPoints", false), 1000) };
}

async function lookup(page, book) {
  const possible = await search(page, book);
  if (possible.length > MAX_DETAILS) throw new Error("Too many exact-title candidates; identity remained unverified.");
  const accepted = [];
  for (const candidate of possible) {
    await politeDelay();
    const evidence = await detail(page, candidate);
    if (confirmedDetail(book, evidence)) accepted.push(evidence);
  }
  // All bounded pages/candidate details were considered. Different
  // quiz identities never become a 'best' fuzzy match.
  return accepted.length === 1 ? accepted[0] : null;
}

async function diagnostics(page) {
  if (process.env.SYNC_DEBUG !== "1") return;
  // A public Actions artifact must not contain an unmatched student's
  // entered title/author/ISBN, page HTML, screenshot, cookie or session URL.
  const route = new URL(page.url()).pathname.toLowerCase();
  const fields = ["txtTitle","txtAuthor","txtISBN","lstQuizType","lstLanguage","btnDoIt","lblSearchResultFailedLabel","ucSearchResultsHeader_lblResultSummary","ucSeachResults_lblResultsSummaryTop","ucSeachResults_lblQuizzes","ucSeachResults_btnNextPageTop"];
  const states = [];
  for (const field of fields) {
    const locator = page.locator("#" + PREFIX + field);
    const count = await locator.count().catch(() => 0);
    states.push({ field, count: Math.min(count, 2), visible: count === 1 && await locator.isVisible().catch(() => false) });
  }
  const data = JSON.stringify({ contract: "arDiagnostic.v2", route: ["/advanced.aspx","/default.aspx","/usertype.aspx","/bookdetail.aspx"].includes(route) ? route : "unexpected", fields: states });
  if (Buffer.byteLength(data, "utf8") > 65536) return;
  await mkdir("diagnostics", { recursive: true });
  await writeFile("diagnostics/verification.json", data);
}

async function boundedFetch(input, init = {}) {
  const deadline = AbortSignal.timeout(30000);
  const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  const response = await fetch(input, { ...init, signal, redirect: "error" });
  if (!response.body) return response;
  const reader = response.body.getReader(); let size = 0; const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error("Database response exceeds the bounded verification size.");
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  return new Response(Buffer.concat(chunks), { status: response.status, statusText: response.statusText, headers: response.headers });
}

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !Number.isSafeInteger(LIMIT) || LIMIT < 1 || LIMIT > 25) throw new Error("Sync configuration is unavailable or unsupported.");
  const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: boundedFetch } });
  const { needed, refused } = await candidates(client);
  // Rotate a bounded contiguous window each scheduled six-hour slot.
  // A repeatedly deferred first page must not pin every later identity.
  // Changing inventories can still alter order; this is not a durable queue.
  const offset = needed.length ? (Math.floor(Date.now() / (6 * 3600000)) * LIMIT) % needed.length : 0;
  const batch = Array.from({ length: Math.min(LIMIT, needed.length) }, (_, i) => needed[(offset + i) % needed.length]);
  console.log(`[sync-ar-data] identities_due=${needed.length} processing=${batch.length} invalid_or_incomplete=${refused}`);
  if (!batch.length) return;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage(); page.setDefaultTimeout(15000); page.setDefaultNavigationTimeout(30000);
  let matched = 0, unverified = 0, failed = 0;
  try {
    for (let i = 0; i < batch.length; i++) {
      const book = batch[i];
      try {
        const evidence = await lookup(page, book);
        const row = { lookup_key: book.lookupKey, title: book.title, author: book.author, isbn: book.isbn,
          match_status: evidence ? "matched" : "unverified", verification_policy: POLICY, last_checked_at: new Date().toISOString(),
          ar_quiz_number: evidence?.quiz ?? null, atos_book_level: evidence?.atos ?? null, interest_level: evidence?.interest ?? null, ar_points: evidence?.points ?? null,
          matched_title: evidence?.title ?? null, matched_author: evidence?.author ?? null, matched_isbns: evidence?.isbns ?? [], source_url: evidence?.sourceURL ?? null,
          source_language: evidence?.language ?? null, source_quiz_type: evidence ? "ReadingPractice" : null };
        // One scheduled writer (workflow concurrency). Date-conditional
        // updates refuse a changed original timestamp. A privileged manual
        // field edit retaining that timestamp is not a full revision CAS.
        let response;
        if (book.prior === null) response = await client.from(TABLE).insert(row).select("lookup_key");
        else response = await client.from(TABLE).update(row).eq("lookup_key", book.lookupKey).eq("last_checked_at", book.prior.last_checked_at).eq("verification_policy", POLICY).select("lookup_key");
        if (response.error || !Array.isArray(response.data) || response.data.length !== 1 || response.data[0].lookup_key !== book.lookupKey) throw new Error("The original verification row changed or could not be saved.");
        if (evidence) matched++; else unverified++;
        console.log(`[sync-ar-data] ${i + 1}/${batch.length}: ${evidence ? "identity_confirmed" : "no_confirmed_match"}`);
      } catch {
        failed++;
        console.error(`[sync-ar-data] ${i + 1}/${batch.length}: deferred; prior data preserved. Inspect diagnostic artifact when enabled.`);
        await diagnostics(page).catch(() => {});
      }
      if (i < batch.length - 1) await politeDelay();
    }
  } finally { await context.close(); await browser.close(); }
  console.log(`[sync-ar-data] matched=${matched} unverified=${unverified} deferred=${failed}`);
  if (failed > 0) process.exitCode = 1;
}
main().catch(() => { console.error("[sync-ar-data] Sync deferred; configuration/schema/network evidence was not complete."); process.exitCode = 1; });
