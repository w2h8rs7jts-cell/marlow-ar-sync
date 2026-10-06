// Shared arIdentity.v2 contract. Case/whitespace only: no fuzzy title,
// punctuation, subtitle, edition, article or author-token deletion.
export const POLICY = "arIdentity.v2";
export const normalizeText = (value) => typeof value === "string" ? value.trim().replace(/\s+/gu, " ").toLowerCase() : "";

export function canonicalISBN(value) {
  if (typeof value !== "string" || value.length > 100) return null;
  const digits = value.replace(/[\s-]/gu, "").toUpperCase();
  if (/^\d{9}[\dX]$/.test(digits)) {
    const sum = [...digits].reduce((sum, c, i) => sum + (c === "X" ? 10 : Number(c)) * (10 - i), 0);
    if (sum % 11 !== 0) return null;
    const prefix = "978" + digits.slice(0, 9);
    const check = (10 - [...prefix].reduce((s, c, i) => s + Number(c) * (i % 2 ? 3 : 1), 0) % 10) % 10;
    return prefix + check;
  }
  if (!/^97[89]\d{10}$/.test(digits)) return null;
  return [...digits].reduce((s, c, i) => s + Number(c) * (i % 2 ? 3 : 1), 0) % 10 === 0 ? digits : null;
}

export function requestedIdentity(title, author, isbn) {
  if (typeof title !== "string" || typeof author !== "string" || title.length > 1000 || author.length > 1000 || /[\x00-\x08\x0E-\x1F\x7F]/.test(title + author)) return null;
  const t = normalizeText(title), a = normalizeText(author);
  if (!t || !a || (isbn != null && typeof isbn !== "string")) return null;
  const providedISBN = isbn != null;
  const canonical = providedISBN ? canonicalISBN(isbn) : null;
  if (providedISBN && !canonical) return null;
  return { title, author, isbn: canonical, lookupKey: POLICY + "|" + JSON.stringify([t, a, canonical]) };
}

export function sourceAuthorMatches(requested, source) {
  const a = normalizeText(requested), b = normalizeText(source);
  if (!a || !b) return false;
  if (a === b) return true;
  // A single official Last, First display may be reversed for a supplied
  // single First Last name. Never split/reorder a supplied author list.
  if (a.includes(",") || a.includes(" and ") || /[&;]/u.test(a) || b.includes(" and ") || /[&;]/u.test(b)) return false;
  const parts = b.split(",");
  return parts.length === 2 && parts.every(p => p.trim()) && normalizeText(parts[1] + " " + parts[0]) === a;
}

export function confirmedDetail(book, detail) {
  if (normalizeText(book.title) !== normalizeText(detail.title) || !sourceAuthorMatches(book.author, detail.author)) return false;
  if (!Number.isSafeInteger(detail.quiz) || detail.quiz <= 0 || detail.language !== "EN" || !detail.quizTypes.includes("Reading Practice")) return false;
  if (book.isbn && !detail.isbns.includes(book.isbn)) return false;
  return true;
}
