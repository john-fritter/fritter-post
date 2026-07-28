import assert from "node:assert/strict";
import {
  charsetFromContentType,
  charsetFromXmlDeclaration,
  resolveCharset,
  decodeFeedBytes,
  DEFAULT_CHARSET,
} from "../src/pipeline/collector/charset.js";

// Run #42 published four titles containing U+FFFD replacement characters, all
// from Brazilian feeds — "oposição" arrived as "oposi��o". The cause is
// rss-parser reading the charset from the Content-Type header only: it ignores
// the XML declaration and does not support windows-1252, so Latin-1 bodies were
// decoded as UTF-8. These tests use the real titles from that run.

const REPLACEMENT = "�";

function latin1(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "latin1"));
}

function utf8(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "utf-8"));
}

// --- charsetFromContentType ---

function testHeaderCharsetParsed() {
  assert.equal(charsetFromContentType("text/xml; charset=utf-8"), "utf-8");
  assert.equal(charsetFromContentType("text/xml;charset=UTF-8"), "utf-8");
  assert.equal(
    charsetFromContentType("application/rss+xml; charset=ISO-8859-1"),
    "windows-1252",
  );
}

function testWindows1252HeaderIsHonoured() {
  // rss-parser discards this label and falls back to UTF-8; we must not.
  assert.equal(
    charsetFromContentType("text/xml; charset=windows-1252"),
    "windows-1252",
  );
}

function testQuotedAndMissingCharset() {
  assert.equal(charsetFromContentType('text/xml; charset="utf-8"'), "utf-8");
  assert.equal(charsetFromContentType("text/xml"), null);
  assert.equal(charsetFromContentType(null), null);
  assert.equal(charsetFromContentType(undefined), null);
}

function testUnknownCharsetLabelIsRejected() {
  assert.equal(charsetFromContentType("text/xml; charset=not-a-charset"), null);
}

// --- charsetFromXmlDeclaration ---

function testXmlDeclarationParsed() {
  const bytes = latin1('<?xml version="1.0" encoding="ISO-8859-1"?><rss></rss>');
  assert.equal(charsetFromXmlDeclaration(bytes), "windows-1252");
}

function testXmlDeclarationSingleQuotes() {
  const bytes = latin1("<?xml version='1.0' encoding='windows-1252'?><rss/>");
  assert.equal(charsetFromXmlDeclaration(bytes), "windows-1252");
}

function testNoDeclarationReturnsNull() {
  assert.equal(charsetFromXmlDeclaration(utf8("<rss><channel/></rss>")), null);
}

function testDeclarationBeyondHeadIsIgnored() {
  // Only the leading bytes are inspected; an "encoding=" deep in the body is
  // content, not a declaration.
  const bytes = utf8("<rss>" + "x".repeat(400) + ' encoding="iso-8859-1" </rss>');
  assert.equal(charsetFromXmlDeclaration(bytes), null);
}

// --- resolveCharset ---

function testHeaderWinsOverDeclaration() {
  const bytes = latin1('<?xml version="1.0" encoding="ISO-8859-1"?><rss/>');
  assert.equal(resolveCharset("text/xml; charset=utf-8", bytes), "utf-8");
}

function testDeclarationUsedWhenHeaderSilent() {
  // The exact gap that produced the bug: bare Content-Type, charset only in XML.
  const bytes = latin1('<?xml version="1.0" encoding="ISO-8859-1"?><rss/>');
  assert.equal(resolveCharset("text/xml", bytes), "windows-1252");
}

function testDefaultsToUtf8() {
  assert.equal(resolveCharset(null, utf8("<rss/>")), DEFAULT_CHARSET);
}

// --- decodeFeedBytes: the regression ---

function testLatin1BodyWithBareHeaderDecodesCleanly() {
  const title = "Ortega quer ampliar mandato para 7 anos em plano que acaba com oposição na Nicarágua";
  const bytes = latin1(`<?xml version="1.0" encoding="ISO-8859-1"?><rss><title>${title}</title></rss>`);

  // What rss-parser did: no header charset, so UTF-8, so mojibake.
  const naive = new TextDecoder("utf-8").decode(bytes);
  assert.ok(naive.includes(REPLACEMENT), "precondition: naive decode corrupts");

  const { text, charset } = decodeFeedBytes(bytes, "text/xml");
  assert.equal(charset, "windows-1252");
  assert.ok(text.includes("oposição"), "accented text must survive");
  assert.ok(text.includes("Nicarágua"));
  assert.ok(!text.includes(REPLACEMENT));
}

function testLyingHeaderIsRecovered() {
  // Header claims UTF-8 but the body is Latin-1. The replacement character is
  // the tell; we retry with the declared encoding.
  const title = "Boom de IA distorce dados e pode levar a erros na política monetária, alerta BIS";
  const bytes = latin1(`<?xml version="1.0" encoding="ISO-8859-1"?><rss><title>${title}</title></rss>`);

  const { text, charset, recovered } = decodeFeedBytes(bytes, "text/xml; charset=utf-8");
  assert.equal(recovered, true, "should report that it recovered");
  assert.equal(charset, "windows-1252");
  assert.ok(text.includes("política monetária"));
  assert.ok(!text.includes(REPLACEMENT));
}

function testLatin1WithoutDeclarationStillRecovers() {
  // No declaration and no header: UTF-8 is tried, fails, windows-1252 rescues it.
  const title = "Visa deve demitir mais de 2.000 funcionários e busca maior eficiência";
  const bytes = latin1(`<rss><title>${title}</title></rss>`);

  const { text, recovered } = decodeFeedBytes(bytes, null);
  assert.equal(recovered, true);
  assert.ok(text.includes("funcionários"));
  assert.ok(text.includes("eficiência"));
  assert.ok(!text.includes(REPLACEMENT));
}

function testGenuineUtf8IsUntouched() {
  // The common case must not be disturbed by any of the above.
  const title = "Os detalhes não esclarecidos de como BYD escapou da lista suja do trabalho escravo";
  const bytes = utf8(`<?xml version="1.0" encoding="UTF-8"?><rss><title>${title}</title></rss>`);

  const { text, charset, recovered } = decodeFeedBytes(bytes, "text/xml; charset=utf-8");
  assert.equal(charset, "utf-8");
  assert.equal(recovered, false);
  assert.ok(text.includes(title));
}

function testNonLatinUtf8Survives() {
  // Russian, Chinese, and Korean feeds are UTF-8 and must stay that way.
  const title = "Украинские дроны атаковали НПЗ в Тюмени — 한겨레 — 端傳媒";
  const bytes = utf8(`<?xml version="1.0" encoding="UTF-8"?><rss><title>${title}</title></rss>`);

  const { text, recovered } = decodeFeedBytes(bytes, "text/xml; charset=utf-8");
  assert.equal(recovered, false);
  assert.ok(text.includes(title));
}

function testUndecodableContentIsReturnedNotThrown() {
  // A byte sequence valid in no encoding must still return a string — the
  // collector is failure-tolerant and one bad feed must not crash the run.
  const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x41, 0x00]);
  const { text } = decodeFeedBytes(bytes, "text/xml; charset=utf-8");
  assert.equal(typeof text, "string");
}

testHeaderCharsetParsed();
testWindows1252HeaderIsHonoured();
testQuotedAndMissingCharset();
testUnknownCharsetLabelIsRejected();
testXmlDeclarationParsed();
testXmlDeclarationSingleQuotes();
testNoDeclarationReturnsNull();
testDeclarationBeyondHeadIsIgnored();
testHeaderWinsOverDeclaration();
testDeclarationUsedWhenHeaderSilent();
testDefaultsToUtf8();
testLatin1BodyWithBareHeaderDecodesCleanly();
testLyingHeaderIsRecovered();
testLatin1WithoutDeclarationStillRecovers();
testGenuineUtf8IsUntouched();
testNonLatinUtf8Survives();
testUndecodableContentIsReturnedNotThrown();
console.log("collector charset tests passed");
