-- Fetched article text for the writers stage.
--
-- The audit of editor run #112 settled why this table exists: 185 of the paper's
-- 305 underlying articles carried under 800 characters of body text, and 132 of
-- them under 300. That is a headline and a lede. The judgment stages can work
-- with it — prefilter reads 500 characters by design — but a writer cannot, and
-- the shortfall is a property of the outlet rather than the story: AP, Al
-- Jazeera, BBC World, NYT and the Oregonian ran 100% teasers in that run, while
-- Meduza, KTVZ, the Bend Bulletin and OPB ran none at all.
--
-- One row per preprocessed item, so the fetch is cached across re-runs of the
-- same day's paper and across the assembler's iterations. Failures are stored
-- too: without them every run re-requests the same paywall, and no report can
-- say what fraction of the paper is running on feed excerpts.
--
-- RETENTION. This is the one place the project holds other people's full text.
-- It exists to write the paper and is never published — "curate, don't
-- reproduce" — and rows are deleted on a rolling window by the fetch script
-- (writers.fetch.retention_days), the same treatment raw_items gets.

CREATE TABLE article_texts (
  id                    BIGSERIAL    PRIMARY KEY,
  preprocessed_item_id  BIGINT       NOT NULL UNIQUE REFERENCES preprocessed_items(id),

  -- Denormalized from the item so the fetcher can group by host and apply the
  -- learned cooldown without a join, and so a report can read this table alone.
  canonical_url         TEXT         NOT NULL,
  host                  TEXT         NOT NULL,

  --   ok       extraction produced a real article body
  --   thin     fetched, but extraction came back under the floor — a paywall, a
  --            consent wall, or a JavaScript shell. Text is kept for diagnosis.
  --   blocked  refused after the one permitted browser-agent retry (403/401/429)
  --   error    transport failure, timeout, 4xx/5xx, or non-HTML content
  --   skipped  not attempted: the feed body was already long enough, or the host
  --            is in cooldown after repeated failures
  status                TEXT         NOT NULL
                        CHECK (status IN ('ok', 'thin', 'blocked', 'error', 'skipped')),
  http_status           INT,
  extractor             TEXT,
  text                  TEXT,
  text_chars            INT          NOT NULL DEFAULT 0,

  -- What the feed gave us, recorded at fetch time. text_chars - feed_chars is
  -- the only honest measure of whether this stage earns its keep.
  feed_chars            INT          NOT NULL DEFAULT 0,

  -- Error message, or the reason a skip was a skip.
  detail                TEXT,

  fetched_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Cache lookups when two items share a canonical URL, and per-report grouping.
CREATE INDEX article_texts_url_idx        ON article_texts (canonical_url);
-- The cooldown query: recent attempts per host, by outcome.
CREATE INDEX article_texts_host_idx       ON article_texts (host, fetched_at DESC);
-- Retention sweep.
CREATE INDEX article_texts_fetched_at_idx ON article_texts (fetched_at DESC);

COMMENT ON TABLE article_texts IS
  'Fetched publisher article text for the writers stage. Third-party full text: used to write the paper, never published, deleted on a rolling window.';
