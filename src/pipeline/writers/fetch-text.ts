/**
 * Article text fetcher for the writers stage.
 *
 * The audit of editor run #112 made this the writers' critical path rather than
 * a nicety: 61% of the paper's 305 underlying articles carried under 800
 * characters of feed body, and 43% under 300. Which articles are thin is a
 * property of the outlet — AP, Al Jazeera, BBC World, NYT and the Oregonian ran
 * 100% teasers; Meduza, KTVZ, the Bend Bulletin and OPB ran 0% — so the policy
 * is per item, not per paper: **fetch only what the feed left short.** On run
 * #112's numbers that is 139 requests instead of 228, and it drops the busiest
 * host from 20 articles to 15.
 *
 * Three rules carried over from the collector, which learned them on feeds:
 *
 * 1. Identify honestly; escalate to a browser identity only on a 403, once.
 * 2. Never retry a 404/410/5xx — those mean gone or broken, not "not to you".
 * 3. Decode with the charset the publisher actually used, not the header's
 *    guess, or accented text arrives as U+FFFD.
 *
 * And one rule of its own: **hosts that keep refusing are left alone.** NYT and
 * OregonLive answer every request with a DataDome device check that the browser
 * identity does not get past, so after `min_attempts` failures inside the
 * cooldown window with nothing successful, the host is skipped up front. The
 * rule is learned from `article_texts` rather than hardcoded, so a host that
 * starts working again recovers by itself when the window rolls past.
 */

import "dotenv/config";
import pLimit from "p-limit";
import { getPool } from "../../db/index.js";
import { loadModelConfig, type WritersFetchConfig } from "../../config/models.js";
import { decodeHtmlBytes } from "../collector/charset.js";
import {
  HONEST_USER_AGENT,
  BROWSER_USER_AGENT,
  BROWSER_HINT_HEADERS,
  hostOf,
} from "../../lib/http.js";
import { stripBoilerplate } from "./boilerplate.js";
import { extractArticle } from "./extract.js";
import { loadEditorRunMaterials, type StoryMaterials } from "./materials.js";

const ACCEPT_HEADER = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

export type FetchStatus = "ok" | "thin" | "blocked" | "error" | "skipped";

/** One URL to fetch, plus every item that shares it. */
export interface FetchTarget {
  canonicalUrl: string;
  host: string;
  items: Array<{ preprocessedItemId: number; feedChars: number }>;
}

/** An item the run decided not to request, and why. */
export interface FetchSkip {
  preprocessedItemId: number;
  canonicalUrl: string;
  host: string;
  feedChars: number;
  detail: string;
  /**
   * True when this skip must not overwrite an existing attempt row.
   *
   * A cooldown skip is *caused* by earlier failures on the host, so recording it
   * over those failures erases the evidence that produced it. Run #112 ended
   * with every nytimes.com and news.google.com row marked `skipped` — and since
   * a skip means "never attempted", the next run would have found no failures,
   * lifted the cooldown, and re-requested all 36. The cooldown has to remember
   * why it exists.
   */
  preservesAttempt?: boolean;
}

export interface FetchPlan {
  targets: FetchTarget[];
  skips: FetchSkip[];
}

/**
 * Which hosts to leave alone this run: those with at least `minAttempts`
 * recorded attempts and not one success. Derived from history rather than
 * configured, so a publisher that lifts a block recovers without a code change
 * once its failures age out of the window.
 */
export function hostsInCooldown(
  rows: Array<{ host: string; status: FetchStatus }>,
  minAttempts: number,
): Set<string> {
  const attempts = new Map<string, { total: number; ok: number }>();
  for (const row of rows) {
    if (row.status === "skipped") continue; // never attempted; says nothing
    const entry = attempts.get(row.host) ?? { total: 0, ok: 0 };
    entry.total++;
    if (row.status === "ok") entry.ok++;
    attempts.set(row.host, entry);
  }
  const cooling = new Set<string>();
  for (const [host, entry] of attempts) {
    if (entry.ok === 0 && entry.total >= minAttempts) cooling.add(host);
  }
  return cooling;
}

/**
 * Decides what to request. Pure, so the policy is testable without a network:
 * in-scope tiers only, only articles the feed left short, nothing on a cooling
 * host, and one request per URL however many items share it.
 */
export function planFetch(
  stories: StoryMaterials[],
  cfg: WritersFetchConfig,
  cooldownHosts: Set<string>,
  recentlyAttempted: Set<number> = new Set(),
): FetchPlan {
  const byUrl = new Map<string, FetchTarget>();
  const skips: FetchSkip[] = [];
  const seenItems = new Set<number>();

  const inScope = new Set<string>(cfg.tiers);

  for (const story of stories) {
    // 'cut' is a tier the editor can assign but never configures a fetch for,
    // so the comparison is on the string rather than the config's narrower union.
    if (!inScope.has(story.tier)) continue;
    for (const article of story.articles) {
      if (seenItems.has(article.preprocessedItemId)) continue;
      seenItems.add(article.preprocessedItemId);

      const host = hostOf(article.canonicalUrl);
      const base = {
        preprocessedItemId: article.preprocessedItemId,
        canonicalUrl: article.canonicalUrl,
        host,
        feedChars: article.feedTextChars,
      };

      // **Long is not the same as complete.** This skip reads a character count
      // and calls it a finished article. La Nación publishes ~1,800-character
      // teasers that stop mid-clause, well clear of the 800 floor, so run #43's
      // rank 15 was never requested and its writer was handed a fragment that
      // broke off inside a quotation — and then wrote about the break, which is
      // the one thing the memo forbids. A body that stops mid-sentence is by
      // definition not the whole article, however long it is, so length does not
      // get to excuse it from the fetch.
      //
      // **Judged on the stripped body, never the raw one.** A feed whose last
      // line is furniture — the Guardian's "Continue reading...", Ars Technica's
      // "Read full article" — has no terminal punctuation at the end of the raw
      // text and is a complete article all the same. Testing before furniture
      // removal made the source audit's 14-day window show 611 such bodies
      // across twelve outlets that are already 100% usable, every one of them a
      // request we would have paid for and thrown away.
      if (
        article.feedTextChars >= cfg.feed_chars_floor &&
        !stripBoilerplate(article.feedText).endedMidSentence
      ) {
        skips.push({ ...base, detail: `feed body already ${article.feedTextChars} chars` });
        continue;
      }
      // Already asked this publisher recently. Run #112's fetch re-requested the
      // 20 URLs its own capped run had just retrieved, because the plan consulted
      // the cooldown but never the cache. Re-running a stage should cost nothing
      // it has already paid for.
      if (recentlyAttempted.has(article.preprocessedItemId)) {
        skips.push({ ...base, detail: `already attempted within refetch_after_hours` });
        continue;
      }
      if (cooldownHosts.has(host)) {
        skips.push({
          ...base,
          detail: `host in cooldown after repeated failures`,
          preservesAttempt: true,
        });
        continue;
      }

      const target = byUrl.get(article.canonicalUrl) ?? {
        canonicalUrl: article.canonicalUrl,
        host,
        items: [],
      };
      target.items.push({
        preprocessedItemId: article.preprocessedItemId,
        feedChars: article.feedTextChars,
      });
      byUrl.set(article.canonicalUrl, target);
    }
  }

  return { targets: [...byUrl.values()], skips };
}

/** Targets grouped by host, busiest first — the unit of serialized politeness. */
export function groupTargetsByHost(targets: FetchTarget[]): Array<[string, FetchTarget[]]> {
  const byHost = new Map<string, FetchTarget[]>();
  for (const target of targets) {
    const list = byHost.get(target.host) ?? [];
    list.push(target);
    byHost.set(target.host, list);
  }
  return [...byHost.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
}

export interface FetchOutcome {
  status: FetchStatus;
  httpStatus: number | null;
  text: string;
  textChars: number;
  extractor: string | null;
  detail: string | null;
}

/**
 * Turns a completed response into an outcome. Separated from the request so the
 * status rules — what counts as blocked, what counts as thin — are testable.
 */
export function classifyResponse(
  httpStatus: number,
  contentType: string | null,
  extractedChars: number,
  minExtractedChars: number,
): Pick<FetchOutcome, "status" | "detail"> {
  if (httpStatus === 403 || httpStatus === 401 || httpStatus === 429) {
    return { status: "blocked", detail: `HTTP ${httpStatus} after browser-agent retry` };
  }
  if (httpStatus < 200 || httpStatus >= 300) {
    return { status: "error", detail: `HTTP ${httpStatus}` };
  }
  if (contentType !== null && !/html|xml/i.test(contentType)) {
    return { status: "error", detail: `content-type ${contentType}` };
  }
  if (extractedChars < minExtractedChars) {
    return {
      status: "thin",
      detail: `extracted ${extractedChars} chars, below the ${minExtractedChars} floor`,
    };
  }
  return { status: "ok", detail: null };
}

function requestOnce(
  url: string,
  userAgent: string,
  timeoutMs: number,
  asBrowser = false,
): Promise<Response> {
  return fetch(url, {
    headers: {
      "User-Agent": userAgent,
      Accept: ACCEPT_HEADER,
      ...(asBrowser ? BROWSER_HINT_HEADERS : {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "follow",
  });
}

/** A timeout is the ceiling doing its job; a dropped socket says nothing. */
export function isTransportError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : "";
  if (name === "TimeoutError" || /timed? ?out/i.test(msg)) return false;
  return /ECONNRESET|socket hang up|premature close|fetch failed|network|EPIPE|ENOTFOUND|other side closed|INTERNAL_ERROR/i.test(
    msg,
  );
}

/**
 * One honest request, retried once if the connection itself failed.
 *
 * Same reasoning `callWithBackoff` applies to LLM calls: re-sending a request
 * whose socket died is correct, because the failure said nothing about the
 * request, while a timeout ran to its configured ceiling and would likely do it
 * again. Run #112 lost 7 of 128 fetches this way, npr.org among them — the same
 * host that failed the manual probe with an HTTP/2 INTERNAL_ERROR.
 */
async function requestWithTransportRetry(
  url: string,
  cfg: WritersFetchConfig,
): Promise<Response> {
  try {
    return await requestOnce(url, HONEST_USER_AGENT, cfg.timeout_ms);
  } catch (err) {
    if (!isTransportError(err)) throw err;
    await new Promise((r) => setTimeout(r, cfg.per_host_delay_ms));
    return await requestOnce(url, HONEST_USER_AGENT, cfg.timeout_ms);
  }
}

/** One article: honest request, one browser retry on 403 only, decode, extract. */
export async function fetchArticleText(
  url: string,
  cfg: WritersFetchConfig,
): Promise<FetchOutcome> {
  const empty = { text: "", textChars: 0, extractor: null };
  let res: Response;
  try {
    res = await requestWithTransportRetry(url, cfg);
    if (res.status === 403) {
      const retry = await requestOnce(url, BROWSER_USER_AGENT, cfg.timeout_ms, true);
      if (retry.ok) res = retry;
      else {
        return {
          ...empty,
          status: "blocked",
          httpStatus: res.status,
          detail: `403 for the honest agent, ${retry.status} for the browser agent`,
        };
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ...empty, status: "error", httpStatus: null, detail: msg };
  }

  const contentType = res.headers.get("content-type");

  if (!res.ok) {
    const { status, detail } = classifyResponse(res.status, contentType, 0, cfg.min_extracted_chars);
    return { ...empty, status, httpStatus: res.status, detail };
  }

  // Size guard before reading: a 40MB page has nothing a writer needs, and
  // buffering it would cost more than the article is worth.
  const declaredLength = Number(res.headers.get("content-length") ?? "0");
  if (declaredLength > cfg.max_bytes) {
    return {
      ...empty,
      status: "error",
      httpStatus: res.status,
      detail: `content-length ${declaredLength} over the ${cfg.max_bytes} cap`,
    };
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ...empty, status: "error", httpStatus: res.status, detail: `body read failed: ${msg}` };
  }
  if (bytes.byteLength > cfg.max_bytes) {
    return {
      ...empty,
      status: "error",
      httpStatus: res.status,
      detail: `body ${bytes.byteLength} bytes over the ${cfg.max_bytes} cap`,
    };
  }

  const { text: html } = decodeHtmlBytes(bytes, contentType);
  const extracted = extractArticle(html);
  const { status, detail } = classifyResponse(
    res.status,
    contentType,
    extracted.chars,
    cfg.min_extracted_chars,
  );

  return {
    status,
    httpStatus: res.status,
    text: extracted.text,
    textChars: extracted.chars,
    extractor: extracted.chars > 0 ? "readability" : null,
    detail,
  };
}

export interface FetchRunSummary {
  editorRunId: number;
  considered: number;
  requested: number;
  hosts: number;
  ok: number;
  thin: number;
  blocked: number;
  error: number;
  skipped: number;
  cooldownHosts: string[];
  charsBefore: number;
  charsAfter: number;
  pruned: number;
}

async function upsert(
  pool: import("pg").Pool,
  row: {
    preprocessedItemId: number;
    canonicalUrl: string;
    host: string;
    status: FetchStatus;
    httpStatus: number | null;
    extractor: string | null;
    text: string | null;
    textChars: number;
    feedChars: number;
    detail: string | null;
  },
  /**
   * When set, an existing row is only replaced if it is itself a skip. Used for
   * cooldown skips, which must not overwrite the failures that caused them.
   */
  onlyOverwriteSkips = false,
): Promise<void> {
  await pool.query(
    `INSERT INTO article_texts
       (preprocessed_item_id, canonical_url, host, status, http_status,
        extractor, text, text_chars, feed_chars, detail, fetched_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
     ON CONFLICT (preprocessed_item_id) DO UPDATE SET
       canonical_url = EXCLUDED.canonical_url,
       host          = EXCLUDED.host,
       status        = EXCLUDED.status,
       http_status   = EXCLUDED.http_status,
       extractor     = EXCLUDED.extractor,
       text          = EXCLUDED.text,
       text_chars    = EXCLUDED.text_chars,
       feed_chars    = EXCLUDED.feed_chars,
       detail        = EXCLUDED.detail,
       fetched_at    = NOW()
     WHERE NOT $11::boolean OR article_texts.status = 'skipped'`,
    [
      row.preprocessedItemId,
      row.canonicalUrl,
      row.host,
      row.status,
      row.httpStatus,
      row.extractor,
      row.text,
      row.textChars,
      row.feedChars,
      row.detail,
      onlyOverwriteSkips,
    ],
  );
}

export interface RunFetchOptions {
  editorRunId: number;
  /** Plan and report without making a single request. */
  dryRun?: boolean;
  /** Cap on URLs requested, for a first cautious run. */
  limit?: number;
}

export async function runArticleFetch(options: RunFetchOptions): Promise<FetchRunSummary> {
  const pool = getPool();
  const cfg = loadModelConfig().writers.fetch;
  const { editorRunId, dryRun = false, limit } = options;

  if (!cfg.enabled) {
    throw new Error("writers.fetch.enabled is false in config/models.yaml");
  }

  // Retention sweep first: this table holds third-party full text and is the
  // only one in the project that does.
  let pruned = 0;
  if (!dryRun) {
    const { rowCount } = await pool.query(
      `DELETE FROM article_texts WHERE fetched_at < NOW() - ($1::int || ' days')::interval`,
      [cfg.retention_days],
    );
    pruned = rowCount ?? 0;
    if (pruned > 0) {
      console.log(`[fetch-text] retention: deleted ${pruned} row(s) older than ${cfg.retention_days}d`);
    }
  }

  const stories = await loadEditorRunMaterials(editorRunId);

  const { rows: historyRows } = await pool.query<{ host: string; status: FetchStatus }>(
    `SELECT host, status FROM article_texts
     WHERE fetched_at >= NOW() - ($1::int || ' days')::interval`,
    [cfg.cooldown.window_days],
  );
  const cooldownHosts = cfg.cooldown.enabled
    ? hostsInCooldown(historyRows, cfg.cooldown.min_attempts)
    : new Set<string>();
  if (cooldownHosts.size > 0) {
    console.log(`[fetch-text] cooldown: skipping ${[...cooldownHosts].join(", ")}`);
  }

  // Items already requested inside the refetch window, whatever the outcome.
  // Skips are excluded: not asking is not the same as having asked.
  const { rows: recentRows } = await pool.query<{ preprocessed_item_id: string }>(
    `SELECT preprocessed_item_id::text AS preprocessed_item_id
     FROM article_texts
     WHERE status <> 'skipped'
       AND fetched_at >= NOW() - ($1::int || ' hours')::interval`,
    [cfg.refetch_after_hours],
  );
  const recentlyAttempted = new Set(recentRows.map((r) => Number(r.preprocessed_item_id)));

  const plan = planFetch(stories, cfg, cooldownHosts, recentlyAttempted);
  const targets = limit !== undefined ? plan.targets.slice(0, limit) : plan.targets;
  const byHost = groupTargetsByHost(targets);

  const considered = targets.length + plan.skips.length;
  console.log(
    `[fetch-text] editor run #${editorRunId}: ${considered} article(s) in scope — ` +
      `${targets.length} to fetch across ${byHost.length} host(s), ${plan.skips.length} skipped` +
      (dryRun ? " [DRY RUN]" : ""),
  );

  const summary: FetchRunSummary = {
    editorRunId,
    considered,
    requested: targets.length,
    hosts: byHost.length,
    ok: 0,
    thin: 0,
    blocked: 0,
    error: 0,
    skipped: plan.skips.length,
    cooldownHosts: [...cooldownHosts],
    charsBefore: 0,
    charsAfter: 0,
    pruned,
  };

  if (dryRun) {
    for (const [host, hostTargets] of byHost) {
      console.log(`[fetch-text]   ${host}: ${hostTargets.length}`);
    }
    return summary;
  }

  for (const skip of plan.skips) {
    await upsert(
      pool,
      {
        preprocessedItemId: skip.preprocessedItemId,
        canonicalUrl: skip.canonicalUrl,
        host: skip.host,
        status: "skipped",
        httpStatus: null,
        extractor: null,
        text: null,
        textChars: 0,
        feedChars: skip.feedChars,
        detail: skip.detail,
      },
      skip.preservesAttempt === true,
    );
  }

  // Hosts run concurrently; each host's own URLs run one at a time with a pause
  // between them. A publisher sees a slow trickle no matter how many of its
  // articles the paper carries.
  const limiter = pLimit(cfg.concurrency);
  await Promise.all(
    byHost.map(([host, hostTargets]) =>
      limiter(async () => {
        for (let i = 0; i < hostTargets.length; i++) {
          const target = hostTargets[i]!;
          if (i > 0) await new Promise((r) => setTimeout(r, cfg.per_host_delay_ms));

          const outcome = await fetchArticleText(target.canonicalUrl, cfg);
          summary[outcome.status === "skipped" ? "skipped" : outcome.status]++;

          for (const item of target.items) {
            summary.charsBefore += item.feedChars;
            summary.charsAfter += Math.max(item.feedChars, outcome.textChars);
            await upsert(pool, {
              preprocessedItemId: item.preprocessedItemId,
              canonicalUrl: target.canonicalUrl,
              host,
              status: outcome.status,
              httpStatus: outcome.httpStatus,
              extractor: outcome.extractor,
              text: outcome.text.length > 0 ? outcome.text : null,
              textChars: outcome.textChars,
              feedChars: item.feedChars,
              detail: outcome.detail,
            });
          }

          if (outcome.status !== "ok") {
            console.log(
              `[fetch-text] ${outcome.status.toUpperCase()} ${host} — ${outcome.detail ?? ""} ` +
                `(${target.canonicalUrl})`,
            );
          }
        }
      }),
    ),
  );

  console.log(
    `[fetch-text] done: ok=${summary.ok} thin=${summary.thin} blocked=${summary.blocked} ` +
      `error=${summary.error} skipped=${summary.skipped} — ` +
      `body text ${summary.charsBefore} → ${summary.charsAfter} chars`,
  );

  return summary;
}
