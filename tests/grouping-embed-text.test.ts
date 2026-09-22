import assert from "node:assert/strict";
import { embedTexts } from "../src/pipeline/grouping/embed-text.js";

function item(title: string, body: string | null, english_title: string | null = null) {
  return { title, english_title, body_text: body, english_body: null };
}

// The normal case is unchanged: title + capped body, and the title alone.
{
  const t = embedTexts(item("Title", "Body  text\nhere"), 100)!;
  assert.equal(t.body, "Title\nBody text here");
  assert.equal(t.title, "Title");
}

// The English columns win when present.
{
  const t = embedTexts(item("Título", "cuerpo", "Title"), 100)!;
  assert.equal(t.title, "Title");
}

// Sep 12: KTVZ item 80915, empty title, substantial body. Neither text may be
// empty, or the provider rejects the whole 200-text request.
{
  const body = "Central Oregon marked the 25th anniversary of September 11 with a memorial. ".repeat(10);
  const t = embedTexts(item("", body, ""), 300)!;
  assert.ok(t.title.length > 0, "a missing title borrows the body's opening");
  assert.ok(t.title.length <= 200);
  assert.ok(t.body.length > 0);
  assert.ok(t.body.startsWith("Central Oregon"), "and is not prefixed to the body twice");
}

// A whitespace-only title is empty too.
assert.ok(embedTexts(item("   ", "Some body"), 100)!.title === "Some body");

// No title and no body: nothing to embed, so the caller leaves it out.
assert.equal(embedTexts(item("", null), 100), null);
assert.equal(embedTexts(item("", "   "), 100), null);

// A title with no body embeds the title for both.
assert.deepEqual(embedTexts(item("Only a title", null), 100), { body: "Only a title", title: "Only a title" });

console.log("grouping embed-text tests passed");
