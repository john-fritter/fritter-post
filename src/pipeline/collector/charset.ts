/**
 * Charset detection and decoding for feed responses.
 *
 * rss-parser's `parseURL` reads the charset from the HTTP Content-Type header
 * and nothing else (`utils.getEncodingFromContentType`). Two gaps follow:
 *
 *   1. A feed that declares its encoding only in the XML declaration
 *      (`<?xml version="1.0" encoding="ISO-8859-1"?>`) and serves a bare
 *      `Content-Type: text/xml` is decoded as UTF-8.
 *   2. `windows-1252` is not in rss-parser's supported list, so even when the
 *      header states it, the value is discarded and UTF-8 is used.
 *
 * Either way, Latin-1 bytes read as UTF-8 produce U+FFFD replacement characters:
 * "oposição" becomes "oposi��o". Run #42 carried four such titles into
 * the published paper, all from Brazilian feeds — and because the corruption
 * happens at fetch time it also reached the embeddings.
 *
 * These helpers detect the charset from the header first, then the XML
 * declaration, then default to UTF-8, and decode via TextDecoder (which does
 * support windows-1252).
 */

// Node's TextDecoder accepts these directly; the map normalizes the spellings
// feeds actually use to labels the WHATWG encoding registry recognizes.
const CHARSET_ALIASES: Record<string, string> = {
  "utf8": "utf-8",
  "utf-8": "utf-8",
  "latin1": "windows-1252",
  // ISO-8859-1 is decoded as windows-1252 per the WHATWG encoding standard:
  // the bytes 0x80–0x9F are undefined in true Latin-1 but carry printable
  // characters (curly quotes, em dashes) in the charset publishers actually
  // emit under that label. Browsers do the same thing.
  "iso-8859-1": "windows-1252",
  "iso8859-1": "windows-1252",
  "windows-1252": "windows-1252",
  "cp1252": "windows-1252",
  "iso-8859-15": "iso-8859-15",
  "utf-16": "utf-16le",
  "utf-16le": "utf-16le",
  "utf-16be": "utf-16be",
  "shift_jis": "shift_jis",
  "sjis": "shift_jis",
  "euc-jp": "euc-jp",
  "euc-kr": "euc-kr",
  "gb2312": "gbk",
  "gbk": "gbk",
  "big5": "big5",
  "windows-1251": "windows-1251",
  "koi8-r": "koi8-r",
};

export const DEFAULT_CHARSET = "utf-8";

function normalizeCharset(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.trim().toLowerCase().replace(/^["']|["']$/g, "");
  if (!cleaned) return null;
  const mapped = CHARSET_ALIASES[cleaned];
  if (mapped) return mapped;
  // Unknown label: accept it only if TextDecoder can honour it, so a typo or an
  // exotic charset degrades to the default rather than throwing mid-collection.
  try {
    new TextDecoder(cleaned);
    return cleaned;
  } catch {
    return null;
  }
}

/** Extracts the charset parameter from a Content-Type header value. */
export function charsetFromContentType(
  contentType: string | null | undefined,
): string | null {
  if (!contentType) return null;
  const match = contentType.match(/charset\s*=\s*([^;\s]+)/i);
  return normalizeCharset(match?.[1]);
}

/**
 * Extracts the encoding from an XML declaration at the start of the document.
 * The declaration is ASCII by construction, so reading the leading bytes as
 * latin1 is safe regardless of the document's real encoding.
 */
export function charsetFromXmlDeclaration(bytes: Uint8Array): string | null {
  const head = Buffer.from(
    bytes.subarray(0, Math.min(bytes.length, 200)),
  ).toString("latin1");
  const match = head.match(/<\?xml[^>]*\bencoding\s*=\s*["']([^"']+)["']/i);
  return normalizeCharset(match?.[1]);
}

/**
 * Resolves the charset for a feed response: Content-Type header, then XML
 * declaration, then UTF-8. The header wins because it describes what was
 * actually transmitted; a stale declaration inside a re-encoded document is the
 * more common disagreement.
 */
export function resolveCharset(
  contentType: string | null | undefined,
  bytes: Uint8Array,
): string {
  return (
    charsetFromContentType(contentType) ??
    charsetFromXmlDeclaration(bytes) ??
    DEFAULT_CHARSET
  );
}

const REPLACEMENT_CHAR = "�";

// A retry is only worth attempting when the replacement characters look
// *systematic* — the whole document decoded under the wrong charset — rather
// than incidental. The two cases are three orders of magnitude apart: a Latin-1
// document read as UTF-8 emits a replacement character for roughly every
// accented letter (~5 per 1000 chars), while a UTF-8 document containing one
// malformed byte emits one in the whole file.
//
// The distinction matters because windows-1252 maps every byte to some
// character and so can never produce U+FFFD. Without a gate, any UTF-8 document
// with a single bad byte "improves" under windows-1252 and gets silently
// re-decoded — which for a Cyrillic feed turns "Кризисную" into "ÐšÑ€Ð¸Ð·Ð¸ÑÐ½ÑƒÑŽ".
// That damage contains no U+FFFD, so it is invisible to the obvious check.
const MIN_REPLACEMENTS_FOR_RETRY = 5;
const REPLACEMENT_RATE_FOR_RETRY = 1 / 2000;

function replacementCount(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === REPLACEMENT_CHAR) n++;
  }
  return n;
}

function looksSystematicallyMisdecoded(text: string): boolean {
  if (text.length === 0) return false;
  const count = replacementCount(text);
  if (count < MIN_REPLACEMENTS_FOR_RETRY) return false;
  return count / text.length >= REPLACEMENT_RATE_FOR_RETRY;
}

// Second guard on a single-byte retry: UTF-8 bytes read as windows-1252 produce
// a recognizable signature — "Ã" before Latin accents, "Ð"/"Ñ" before Cyrillic,
// "â€" before curly quotes and dashes. These are vanishingly rare in genuine
// windows-1252 text (they are capitals, or a bigram) but appear once per
// non-ASCII character in mojibake. If a retry produces them, it made things
// worse and must be rejected.
const MOJIBAKE_MARKERS = /[ÃÐÑÂ]|â€/g;
const MOJIBAKE_RATE_LIMIT = 1 / 200;

function looksLikeUtf8ReadAsSingleByte(text: string): boolean {
  if (text.length === 0) return false;
  const matches = text.match(MOJIBAKE_MARKERS);
  if (!matches) return false;
  return matches.length / text.length >= MOJIBAKE_RATE_LIMIT;
}

/**
 * Decodes feed bytes using the resolved charset, retrying only when the first
 * decode looks systematically wrong rather than merely imperfect. A feed whose
 * header claims UTF-8 while its body is Latin-1 is the case worth recovering; a
 * UTF-8 feed with one malformed byte is not, and must be left alone.
 */
export function decodeFeedBytes(
  bytes: Uint8Array,
  contentType: string | null | undefined,
): { text: string; charset: string; recovered: boolean } {
  const charset = resolveCharset(contentType, bytes);
  const text = new TextDecoder(charset).decode(bytes);

  if (!looksSystematicallyMisdecoded(text)) {
    return { text, charset, recovered: false };
  }

  // The transport and the document disagree — prefer what the document says.
  const declared = charsetFromXmlDeclaration(bytes);
  if (declared && declared !== charset) {
    const retry = new TextDecoder(declared).decode(bytes);
    if (
      !looksSystematicallyMisdecoded(retry) &&
      !looksLikeUtf8ReadAsSingleByte(retry)
    ) {
      return { text: retry, charset: declared, recovered: true };
    }
  }

  // Last resort for a document nothing correctly labelled.
  if (charset !== "windows-1252") {
    const retry = new TextDecoder("windows-1252").decode(bytes);
    if (
      !looksSystematicallyMisdecoded(retry) &&
      !looksLikeUtf8ReadAsSingleByte(retry)
    ) {
      return { text: retry, charset: "windows-1252", recovered: true };
    }
  }

  return { text, charset, recovered: false };
}
