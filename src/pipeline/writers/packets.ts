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
import { assembleWriterPacket, type ResolvedText, type WriterPacket } from "./assembler.js";
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
 * Fetched article text, keyed by item. Only `ok` rows count: a `thin` row holds
 * whatever came back from a paywall or a consent wall, which is kept in the
 * table for diagnosis and must not reach a writer as if it were the article.
 */
export async function loadFetchedTexts(itemIds: number[]): Promise<Map<number, ResolvedText>> {
  if (itemIds.length === 0) return new Map();
  const pool = getPool();
  const { rows } = await pool.query<{ preprocessed_item_id: string; text: string | null }>(
    `SELECT preprocessed_item_id::text AS preprocessed_item_id, text
     FROM article_texts
     WHERE status = 'ok' AND text IS NOT NULL AND preprocessed_item_id = ANY($1::bigint[])`,
    [itemIds],
  );
  return new Map(
    rows.map((r) => [Number(r.preprocessed_item_id), { text: r.text!, origin: "fetched" as const }]),
  );
}

export interface RenderedPacket {
  packet: WriterPacket;
  systemPrompt: string;
  userPrompt: string;
  promptChars: number;
}

/** Every story of an editor run, assembled and rendered into writer prompts. */
export async function buildEditorRunPackets(editorRunId: number): Promise<RenderedPacket[]> {
  const cfg = loadModelConfig().writers.packet;
  const stories = await loadEditorRunMaterials(editorRunId);

  const itemIds = [...new Set(stories.flatMap((s) => s.articles.map((a) => a.preprocessedItemId)))];
  const textsById = await loadFetchedTexts(itemIds);

  const bio = loadDoc("bio.md", BIO_FALLBACK);
  const voice = loadDoc("voice.md", VOICE_FALLBACK);

  return stories.map((story) => {
    const packet = assembleWriterPacket(story, textsById, cfg);
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
