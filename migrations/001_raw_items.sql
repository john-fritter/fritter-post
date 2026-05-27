-- Raw items: collector output. One row per item per source fetch.
-- Idempotency is enforced via the unique constraint on (source_name, item_guid).
-- item_guid is the feed's own identifier (RSS <guid> / Atom <id>); when the
-- feed omits one, the collector should hash (source_name, original_url) and
-- store that as a synthetic guid.

CREATE TABLE raw_items (
  id             BIGSERIAL PRIMARY KEY,

  -- Source identification (matches name field in config/sources.yaml)
  source_name    TEXT        NOT NULL,
  source_type    TEXT        NOT NULL, -- wire | journalism | advocacy | newsletter
  feed_url       TEXT        NOT NULL,

  -- Stable identifier supplied by the feed, used for idempotent inserts.
  -- When the feed has no guid, the collector synthesises one.
  item_guid      TEXT        NOT NULL,

  -- URLs: original from the feed, and canonical after normalization.
  -- Canonicalization (tracking params, AMP, etc.) is the preprocessor's job;
  -- the collector just stores both.
  original_url   TEXT        NOT NULL,
  url            TEXT,          -- populated by preprocessor; NULL until then

  -- Article content as provided by the feed. Body is often absent or partial.
  title          TEXT        NOT NULL,
  body           TEXT,
  author         TEXT,

  -- Timestamps
  published_at   TIMESTAMPTZ,  -- from the feed; NULL if the feed omits it
  fetched_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Full raw feed entry preserved for debugging and future extraction.
  raw_entry      JSONB       NOT NULL,

  -- Idempotency: one row per (source, guid).
  CONSTRAINT raw_items_source_guid_unique UNIQUE (source_name, item_guid)
);

-- Fast lookups by source (triage reads one source's items; inspector filters)
CREATE INDEX raw_items_source_name_idx ON raw_items (source_name);

-- Retention window management: delete old items by fetch time
CREATE INDEX raw_items_fetched_at_idx ON raw_items (fetched_at DESC);

-- Preprocessor dedup: find items that share a canonical URL
CREATE INDEX raw_items_url_idx ON raw_items (url) WHERE url IS NOT NULL;
