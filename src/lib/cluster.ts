/**
 * Shared cluster types and the flat-line cluster parser, used by the
 * embedding-based grouping stage and the downstream pile/editor stages.
 */

export interface Cluster {
  title: string;
  item_ids: number[];
  summary: string;
  notes: string | null;
}

export interface FlatClusterParseResult {
  clusters: Cluster[];
  fabricatedIds: number[];
  duplicateIds: number[];
  droppedSingletonCount: number;
  parsedLineCount: number;
}

/**
 * Parses the flat line-based cluster format:
 *   label;;summary;;id,id,id,...
 *
 * The id list is last so any ;; inside summary cannot shift the id column.
 * Validates each cluster against inputIds: drops fabricated ids (logs them),
 * records duplicates (logs them), and drops clusters with fewer than 2 valid ids.
 * Returns null only if the entire output has no parseable cluster lines.
 */
export function parseFlatClusterOutput(
  text: string,
  inputIds: Set<number>,
): FlatClusterParseResult | null {
  const seenIds = new Set<number>();
  const clusters: Cluster[] = [];
  const allFabricated: number[] = [];
  const allDuplicates: number[] = [];
  let parsedLineCount = 0;
  let droppedSingletonCount = 0;

  // Pre-pass: join split-line clusters.
  // The model may emit "label;;summary" on one line and "id,id,..." on the next.
  // Detect: line with exactly one ;;, followed by a bare id-list line.
  const rawLines = text.split(/\r?\n/);
  const lines: string[] = [];
  {
    let i = 0;
    while (i < rawLines.length) {
      const line = rawLines[i]!.trim();
      const firstSep = line.indexOf(";;");
      if (firstSep !== -1 && line.indexOf(";;", firstSep + 2) === -1) {
        // Exactly one ;; — look ahead for a bare id list.
        let j = i + 1;
        while (j < rawLines.length && rawLines[j]!.trim().length === 0) j++;
        if (j < rawLines.length && /^\d+(?:,\s*\d+)*$/.test(rawLines[j]!.trim())) {
          lines.push(`${line};;${rawLines[j]!.trim()}`);
          i = j + 1;
          continue;
        }
      }
      lines.push(line);
      i++;
    }
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    const first = line.indexOf(";;");
    if (first === -1) continue;
    const last = line.lastIndexOf(";;");
    if (last === first) continue; // only one ;; — needs exactly two distinct occurrences

    parsedLineCount++;

    const label = line.slice(0, first).trim();
    const summary = line.slice(first + 2, last).trim(); // absorbs any ;; inside summary
    const idPart = line.slice(last + 2).trim();

    if (label.length === 0 || summary.length === 0) {
      console.warn(`[cluster] skipping malformed line: empty label or summary`);
      continue;
    }

    const fabricated: number[] = [];
    const duplicate: number[] = [];
    const validIds: number[] = [];

    for (const tok of idPart.split(",")) {
      const trimmed = tok.trim();
      if (!/^\d+$/.test(trimmed)) continue;
      const id = Number.parseInt(trimmed, 10);
      if (!inputIds.has(id)) {
        fabricated.push(id);
      } else if (seenIds.has(id)) {
        duplicate.push(id);
      } else {
        validIds.push(id);
        seenIds.add(id);
      }
    }

    if (fabricated.length > 0) {
      console.warn(`[cluster] fabricated ids in cluster "${label}": ${fabricated.join(", ")}`);
      allFabricated.push(...fabricated);
    }
    if (duplicate.length > 0) {
      console.warn(`[cluster] duplicate ids (appeared in earlier cluster): ${duplicate.join(", ")}`);
      allDuplicates.push(...duplicate);
    }

    if (validIds.length < 2) {
      console.warn(
        `[cluster] dropped cluster "${label}": only ${validIds.length} valid id(s) after filtering`,
      );
      droppedSingletonCount++;
      continue;
    }

    clusters.push({ title: label, item_ids: validIds, summary, notes: null });
  }

  if (parsedLineCount === 0) {
    console.warn(`[cluster] digest parse failed: no cluster lines found`);
    console.warn(`[cluster] first 500 chars: ${text.slice(0, 500)}`);
    return null;
  }

  return {
    clusters,
    fabricatedIds: allFabricated,
    duplicateIds: allDuplicates,
    droppedSingletonCount,
    parsedLineCount,
  };
}
