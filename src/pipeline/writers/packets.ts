/**
 * Loading side of the assembler: an editor run in, writer packets out.
 *
 * Everything with judgment in it lives in `assembler.ts` as pure functions over
 * data. This module only gathers the data — resolved materials, the fetched
 * text, the bio, the standing memo — and hands them over.
 */

import "dotenv/config";
import { readFileSync } from "fs";
import path from "path";
import { getPool } from "../../db/index.js";
import { loadModelConfig } from "../../config/models.js";
import { loadEditorRunMaterials } from "./materials.js";
import {
  assembleWriterPacket,
  assembleSectionPackets,
  type ResolvedText,
  type WriterPacket,
} from "./assembler.js";
import { buildWriterSystemPrompt, buildWriterUserPrompt, VOICE_FALLBACK } from "./prompt.js";

const DOCS_DIR = path.join(import.meta.dirname, "..", "..", "..", "docs");

const BIO_FALLBACK =
  "(Reader bio unavailable. Write for a general reader who wants plain, direct " +
  "reporting centred on the people a decision lands on.)";

function loadDoc(name: string, fallback: string): string {
  try {
    const content = readFileSync(path.join(DOCS_DIR, name), "utf-8").trim();
    return content.length > 0 ? content : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Fetched article text, keyed by item. `thin` rows count as well as `ok` ones,
 * and the assembler takes whichever of the fetched text and the feed body is
 * longer.
 *
 * This loader used to demand `status = 'ok'`, which threw away real article
 * prose the fetcher had already paid for. `thin` is a *length* verdict laid on
 * top of a structural one that already passed: `extractArticle` returns "" when
 * Readability finds nothing article-shaped and deliberately has no
 * whole-document fallback, so a non-empty `thin` row is a short article, not nav
 * soup. Run #28's C20 was a feature lead written on 49 words: one of its sources
 * was dropped from the packet entirely while 1,035 characters of its extracted
 * text sat in this table, and another used a 395-character feed teaser over a
 * 574-character extraction of the same story.
 *
 * The paywall stub this filter was built for is handled by the comparison rather
 * than by exclusion — a stub shorter than the feed teaser loses to it, and one
 * longer than the teaser carries more of the article than the teaser did.
 */
export async function loadFetchedTexts(itemIds: number[]): Promise<Map<number, ResolvedText>> {
  if (itemIds.length === 0) return new Map();
  const pool = getPool();
  const { rows } = await pool.query<{ preprocessed_item_id: string; text: string | null }>(
    `SELECT preprocessed_item_id::text AS preprocessed_item_id, text
     FROM article_texts
     WHERE status IN ('ok', 'thin') AND text IS NOT NULL AND preprocessed_item_id = ANY($1::bigint[])`,
    [itemIds],
  );
  return new Map(
    rows.map((r) => [Number(r.preprocessed_item_id), { text: r.text!, origin: "fetched" as const }]),
  );
}

/**
 * The two standing documents, loaded once. Exported so the writers stage reads
 * the same bio the prompts were rendered with, rather than recovering it by
 * slicing a prompt back apart.
 */
export function loadWriterDocs(): { bio: string; voice: string } {
  return {
    bio: loadDoc("bio.md", BIO_FALLBACK),
    voice: loadDoc("voice.md", VOICE_FALLBACK),
  };
}

export interface RenderedPacket {
  packet: WriterPacket;
  systemPrompt: string;
  userPrompt: string;
  promptChars: number;
}

/**
 * Keeps the paper the size the editor said it was.
 *
 * A thread expands into a lead, sidebars and lines, so a 150-story editor run
 * yields more than 150 pieces. Rather than letting the paper grow, the tail of
 * the ranked list gives up its slots — deeper coverage of eleven real situations
 * costs the lowest-scoring unrelated items, which is the trade a section is for.
 * Run #112's bottom briefs scored 56 while a story inside T1 scored 81.
 *
 * Section pieces are never dropped: the displacement comes off standalone
 * stories from the bottom of the rank order, and at least one standalone story
 * always survives so a pathological day cannot produce a paper of nothing but
 * threads.
 */
export function applyPaperBudget(packets: WriterPacket[], target: number): WriterPacket[] {
  if (packets.length <= target) return packets;

  const overflow = packets.length - target;
  const standalone = packets
    .map((packet, index) => ({ packet, index }))
    .filter((entry) => entry.packet.section === null)
    .sort((a, b) => b.packet.rank - a.packet.rank);

  const droppable = Math.max(0, standalone.length - 1);
  const dropIndexes = new Set(standalone.slice(0, Math.min(overflow, droppable)).map((e) => e.index));

  return packets.filter((_packet, index) => !dropIndexes.has(index));
}

/** Every story of an editor run, assembled and rendered into writer prompts. */
export async function buildEditorRunPackets(editorRunId: number): Promise<RenderedPacket[]> {
  const cfg = loadModelConfig().writers.packet;
  const stories = await loadEditorRunMaterials(editorRunId);

  const itemIds = [...new Set(stories.flatMap((s) => s.articles.map((a) => a.preprocessedItemId)))];
  const textsById = await loadFetchedTexts(itemIds);

  const { bio, voice } = loadWriterDocs();

  // A thread becomes a section of several pieces; everything else is one piece.
  const expanded = stories.flatMap((story) =>
    story.itemType === "thread"
      ? assembleSectionPackets(story, textsById, cfg)
      : [assembleWriterPacket(story, textsById, cfg)],
  );

  const budgeted = applyPaperBudget(expanded, stories.length);
  const dropped = expanded.length - budgeted.length;
  const sectionPieces = budgeted.filter((p) => p.section !== null).length;
  if (sectionPieces > 0) {
    console.log(
      `[writers] editor run #${editorRunId}: ${stories.length} stories → ${expanded.length} pieces ` +
        `(${sectionPieces} in sections), ${dropped} standalone piece(s) displaced to hold the paper at ${stories.length}`,
    );
  }

  return budgeted.map((packet) => {
    const systemPrompt = buildWriterSystemPrompt(voice);
    const userPrompt = buildWriterUserPrompt(bio, packet);
    return {
      packet,
      systemPrompt,
      userPrompt,
      promptChars: systemPrompt.length + userPrompt.length,
    };
  });
}
