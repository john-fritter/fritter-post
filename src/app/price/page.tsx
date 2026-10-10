/**
 * What today's paper cost: the page behind the masthead's price box.
 *
 * The price is the paper's model calls at list prices, frozen when the paper
 * was published (paper_steps, paper_costs). It is an estimate, and the page
 * says so in its first paragraph: the paper runs on a flat-rate subscription.
 *
 * It is also the one page that explains how the paper is made, so it is
 * written for someone who has never seen the pipeline. The step names here are
 * plain words ("Clean up", "Group", "Read") and are this page's alone; the
 * pipeline keeps its own.
 *
 * Colour still means a link out: the bars are ink, and only the price sources
 * at the bottom are blue.
 */

import Link from "next/link";
import type { Metadata } from "next";
import { formatEditionDate } from "@/pipeline/publish/assemble";
import { loadLatestPaper, loadPaperPrice } from "@/pipeline/publish/read";
import {
  PRICE_STEPS,
  buildPriceView,
  formatRate,
  formatSpan,
  formatStepTime,
  formatTokenWords,
  formatTokens,
  formatUsd,
  type PriceStep,
  type StepView,
} from "@/pipeline/publish/price";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "What this paper cost — The Fritter Post" };

// A timeline segment narrower than this share of the run is too thin to carry
// its number legibly; the key underneath still names it.
const MIN_LABELLED_SEGMENT = 0.06;

const PAPER_TIMEZONE = process.env["PAPER_TIMEZONE"] ?? "America/Los_Angeles";

const STEP_COPY: Record<PriceStep, { title: string; does: (s: StepView) => string; verb: string }> = {
  collect: {
    title: "Collect",
    does: (s) =>
      s.sources !== null
        ? `Checks ${s.sources.toLocaleString("en-US")} news sources for everything published since yesterday morning.`
        : "Checks the paper's news sources for everything published since yesterday morning.",
    verb: "collects",
  },
  preprocess: {
    title: "Clean up",
    does: () =>
      "Removes duplicates, stale stories and junk, and translates the articles that aren't in English.",
    verb: "translates",
  },
  screen: {
    title: "Screen",
    does: () =>
      "A first read of every article against what this reader cares about. Cuts what doesn't belong, and tells news from opinion.",
    verb: "screens",
  },
  cluster: {
    title: "Group",
    does: () =>
      "Finds articles about the same event, so ten outlets' reports of one fire become one story with ten sources.",
    verb: "groups",
  },
  score: {
    title: "Score",
    does: () =>
      "Judges every story for how much it matters and to whom, checks it is actually new, and links stories that belong to an ongoing situation.",
    verb: "scores",
  },
  rank: {
    title: "Rank",
    does: () =>
      "Puts the paper in order by score and by how many separate outlets reported each story, and decides which get a full piece. A model is asked only to break ties.",
    verb: "ranks",
  },
  fetch: {
    title: "Read",
    does: () =>
      "Fetches the full text behind the bigger stories, so they are written from the reporting and not from a summary.",
    verb: "reads",
  },
  write: {
    title: "Write",
    does: () =>
      "Writes every piece in the paper from its sources, in the house voice: features, standard stories and briefs.",
    verb: "writes",
  },
  publish: {
    title: "Publish",
    does: () =>
      "Lays out the paper, attaches the links to the original reporting, and notes when the paper has covered a story before.",
    verb: "checks back issues",
  },
};

function stepNumber(s: PriceStep): number {
  return PRICE_STEPS.indexOf(s) + 1;
}

function n(v: number): string {
  return v.toLocaleString("en-US");
}

function plural(count: number, one: string, many: string): string {
  return `${n(count)} ${count === 1 ? one : many}`;
}

/** "6:00 a.m." in the reader's timezone. */
function clockTime(d: Date): string {
  const s = new Intl.DateTimeFormat("en-US", {
    hour: "numeric", minute: "2-digit", timeZone: PAPER_TIMEZONE,
  }).format(d);
  return s.replace(/\s?AM$/, " a.m.").replace(/\s?PM$/, " p.m.");
}

/** "October 2026", from YYYY-MM-DD. */
function monthYear(iso: string): string {
  const [y, m] = iso.split("-").map((p) => parseInt(p, 10));
  if (y === undefined || m === undefined || Number.isNaN(y)) return iso;
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(y, m - 1, 1)));
}

function listWords(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

function StepMeta({ s }: { s: StepView }) {
  const parts: React.ReactNode[] = [];
  if (s.models.length === 0) parts.push("Software only");
  for (const m of s.models) parts.push(<span className="model">{m}</span>);
  if (s.calls > 0) parts.push(plural(s.calls, "call", "calls"));
  if (s.tokens > 0) parts.push(`${formatTokens(s.tokens)} tokens`);
  if (s.models.length === 0 && s.itemsOut !== null) parts.push(plural(s.itemsOut, "article", "articles"));
  if (s.durationMs !== null) parts.push(formatStepTime(s.durationMs));
  return (
    <p className="pr-meta">
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 ? <span className="sep">·</span> : null}
          {p}
        </span>
      ))}
    </p>
  );
}

export default async function PricePage() {
  const paper = await loadLatestPaper();
  const price = paper ? await loadPaperPrice(paper.id) : null;

  if (!paper || !price) {
    return (
      <main className="app">
        <Link className="back" href="/">← Today's paper</Link>
        <div className="empty">
          <h2>No price yet</h2>
          <p>This edition was published before the paper had a price.</p>
        </div>
      </main>
    );
  }

  const view = buildPriceView(price);
  const step = (s: PriceStep) => view.steps.find((v) => v.step === s)!;
  const collect = step("collect");

  const funnel: Array<{ count: number | null; what: string; last?: boolean }> = [
    { count: collect.itemsOut, what: "articles collected since yesterday morning" },
    { count: step("preprocess").itemsOut, what: "after duplicates, old news and junk are removed" },
    { count: step("screen").itemsOut, what: "pass the first read" },
    { count: step("cluster").itemsOut, what: "distinct events, once same-story reports are grouped" },
    {
      count: paper.storyCount,
      what:
        `stories make the paper: ${plural(price.tiers.feature, "feature", "features")}, ` +
        `${n(price.tiers.standard)} standard, ${plural(price.tiers.brief, "brief", "briefs")}`,
      last: true,
    },
  ];
  const funnelTop = funnel[0]!.count ?? 0;
  const shownFunnel = funnel.filter((f) => f.count !== null);

  const timed = view.steps.filter((s) => s.durationMs !== null && s.durationMs > 0);

  return (
    <main className="app pr">
      <Link className="back" href="/">← Today's paper</Link>
      <header className="pr-head">
        <p className="kicker">{formatEditionDate(paper.publishedOn)}</p>
        <h1 className="pr-title">What this paper cost</h1>
        <div className="pr-price">
          <div className="pr-tag">
            <span className="ear-l">Price</span>
            <span className="pr-tag-p">{formatUsd(view.totalUsd)}</span>
          </div>
          <p>An estimate, at the model makers' published API prices.</p>
        </div>
        <p className="pr-lede">
          The Fritter Post is written every morning by a program that reads the news and a
          handful of AI models that judge and write it. The price above represents the cost of
          the words read and written by those models for today's paper. It's based on API
          prices, not what I actually pay (I have a flat-rate subscription).
        </p>
      </header>

      <div className="pr-figs">
        {collect.itemsOut !== null ? (
          <div className="pr-fig">
            <b>{n(collect.itemsOut)}</b>
            <span>
              articles read{collect.sources !== null ? ` from ${n(collect.sources)} sources` : ""}
            </span>
          </div>
        ) : null}
        <div className="pr-fig">
          <b>{n(paper.storyCount)}</b>
          <span>stories in today's paper</span>
        </div>
        <div className="pr-fig">
          <b>{n(view.calls)}</b>
          <span>model calls, {formatTokenWords(view.tokens)} tokens</span>
        </div>
        {view.workMs > 0 ? (
          <div className="pr-fig">
            <b>{Math.max(1, Math.round(view.workMs / 60_000))} min</b>
            <span>from first feed to front page</span>
          </div>
        ) : null}
      </div>

      <div className="pr-cols">
        <div className="pr-main">
          <section className="pr-sec">
            <h2 className="pr-label">How the paper is made</h2>
            <p className="pr-hl">Nine steps, every morning</p>
            <p className="pr-p">
              Software does the mechanical work. The models do the reading, judging and writing.
              Here's what each step did today, and what it would have cost.
            </p>
            <ol className="pr-steps">
              {view.steps.map((s) => {
                const copy = STEP_COPY[s.step];
                return (
                  <li className="pr-step" key={s.step}>
                    <span className="rank">{String(stepNumber(s.step)).padStart(2, "0")}</span>
                    <div>
                      <div className="pr-step-top">
                        <h3>{copy.title}</h3>
                        <span className={s.costUsd > 0 ? "pr-usd" : "pr-usd zero"}>
                          {formatUsd(s.costUsd)}
                        </span>
                      </div>
                      <p className="pr-step-does">{copy.does(s)}</p>
                      <div className="pr-meter" aria-hidden="true">
                        <i style={{ width: `${(s.share * 100).toFixed(1)}%` }} />
                      </div>
                      <StepMeta s={s} />
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>

          <section className="pr-sec pr-fine">
            <h2 className="pr-label">About these numbers</h2>
            <p>
              <b>Every call counts,</b> including retries and calls that failed, because a provider
              bills those too. The token counts are the ones each provider reported back.
            </p>
            <p>
              <b>Prices are list prices</b> from each model's maker, with no caching or off-peak
              discounts{view.pricesAsOf ? `, as of ${monthYear(view.pricesAsOf)}` : ""}
              {view.sources.length > 0 ? ": " : "."}
              {view.sources.map((src, i) => (
                <span key={src.url}>
                  {i > 0 ? ", " : null}
                  <a href={src.url}>{src.site}</a>
                </span>
              ))}
              {view.sources.length > 0 ? "." : null}
            </p>
            {view.unpriced.length > 0 ? (
              <p>
                <b>Not priced:</b> {listWords(view.unpriced)} had no list price on file, so
                {view.unpriced.length === 1 ? " its calls are" : " their calls are"} not in the
                total.
              </p>
            ) : null}
          </section>
        </div>

        <aside className="pr-side">
          {shownFunnel.length > 1 && funnelTop > 0 ? (
            <section className="pr-sec">
              <h2 className="pr-label">From the wire to the page</h2>
              <p className="pr-hl">
                {n(funnelTop)} articles in, {n(paper.storyCount)} stories out
              </p>
              <p className="pr-p">
                Most of the work is throwing things away. Each step narrows the pile until what is
                left is one paper's worth.
              </p>
              <div className="pr-funnel">
                {shownFunnel.map((f, i) => (
                  <div className="pr-fun" key={i}>
                    <div
                      className={f.last ? "pr-bar ink" : "pr-bar"}
                      style={{ width: `${Math.min(100, ((f.count ?? 0) / funnelTop) * 100).toFixed(1)}%` }}
                    >
                      <b>{n(f.count ?? 0)}</b>
                    </div>
                    <span className="pr-what">{f.what}</span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {timed.length > 0 ? (
            <section className="pr-sec">
              <h2 className="pr-label">The morning's run</h2>
              <p className="pr-hl">{formatSpan(view.workMs)}, start to finish</p>
              <p className="pr-p">
                Calls run side by side, so the models worked {formatSpan(view.modelMs)} between
                them inside those {formatSpan(view.workMs)}.
              </p>
              <div className="pr-tl" aria-hidden="true">
                {timed.map((s) => (
                  <i
                    key={s.step}
                    className={s.step === "write" ? "w" : undefined}
                    style={{ flexGrow: s.durationMs! }}
                  >
                    {s.durationMs! / view.workMs >= MIN_LABELLED_SEGMENT ? stepNumber(s.step) : ""}
                  </i>
                ))}
              </div>
              <div className="pr-tl-ends">
                <span>{view.startedAt ? clockTime(view.startedAt) : ""}</span>
                <span>{formatStepTime(view.workMs)}</span>
              </div>
              <div className="pr-tl-key">
                {timed.map((s) => (
                  <span key={s.step}>
                    <b>{stepNumber(s.step)}</b>
                    {STEP_COPY[s.step].title}
                  </span>
                ))}
              </div>
            </section>
          ) : null}

          <section className="pr-sec">
            <h2 className="pr-label">The models</h2>
            <p className="pr-hl">
              {view.models.length === 1 ? "One model" : `${capitalize(numberWord(view.models.length))} models`},
              priced per million tokens
            </p>
            <p className="pr-p">
              A token is about three-quarters of a word. Models charge one price for what they
              read (in) and a higher one for what they write (out), and a model that thinks before
              it answers pays the writing price for its thinking.
            </p>
            <table className="pr-models">
              <thead>
                <tr>
                  <th>Model</th>
                  <th className="r">In</th>
                  <th className="r">Out</th>
                  <th className="r">Today</th>
                </tr>
              </thead>
              <tbody>
                {view.models.map((m) => (
                  <tr key={m.name}>
                    <td>
                      <span className="mn">{m.name}</span>
                      <span className="mk">
                        {[m.maker, listWords(m.steps.map((s) => STEP_COPY[s].verb))]
                          .filter((x) => x)
                          .join(" · ")}
                      </span>
                      <span className="share" style={{ width: `${(m.share * 100).toFixed(1)}%` }} />
                    </td>
                    <td className="r">{m.inputPerMtok !== null ? formatRate(m.inputPerMtok) : "—"}</td>
                    <td className="r">
                      {m.outputPerMtok !== null && (m.outputPerMtok > 0 || m.outputTokens > 0)
                        ? formatRate(m.outputPerMtok)
                        : "—"}
                    </td>
                    <td className="r">
                      <b>{m.costUsd !== null ? formatUsd(m.costUsd) : "—"}</b>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>Total</td>
                  <td />
                  <td />
                  <td className="r">{formatUsd(view.totalUsd)}</td>
                </tr>
              </tfoot>
            </table>
          </section>
        </aside>
      </div>

      <footer className="endmark">
        <p className="thirty">— 30 —</p>
      </footer>
    </main>
  );
}

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

function numberWord(count: number): string {
  return NUMBER_WORDS[count] ?? n(count);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
