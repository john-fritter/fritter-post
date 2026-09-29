/**
 * PostgreSQL TEXT cannot hold U+0000. Every other character is storable, so
 * this removes exactly that one and nothing else.
 *
 * Web text carries NULs more often than it should: a page served as UTF-16 and
 * decoded as UTF-8 interleaves them, and a literal 0x00 in publisher HTML
 * survives linkedom, Readability and html-to-text untouched. Postgres rejects
 * the whole statement (`invalid byte sequence for encoding "UTF8": 0x00`), and
 * on 2026-09-29 one such page stopped fetch-text and cost the day's paper.
 */

const NUL = /\u0000/g;

export function stripNul(s: string): string {
  return s.includes("\u0000") ? s.replace(NUL, "") : s;
}

export function countNul(s: string): number {
  let n = 0;
  for (let i = s.indexOf("\u0000"); i !== -1; i = s.indexOf("\u0000", i + 1)) n++;
  return n;
}
