export interface JunkFilterItem {
  id: string;
  source_name: string;
  title: string;
  body_text: string | null;
}

export interface ClassifyResult {
  keep: boolean;
  reason?: string;
}

type Rule = {
  reason: string;
  test: (title: string, body: string | null) => boolean;
};

// High-precision, low-recall. When in doubt, return false (keep).
// Extend this list from audit logs; do not broaden patterns speculatively.
const RULES: Rule[] = [
  {
    // "Explore calendar May 30-June", "Calendar: June 1-7"
    reason: "event-calendar",
    test: (title) => /\bcalendar\b/i.test(title) && /\d/.test(title),
  },
  {
    // "Photos of the week", "Photos from the week"
    reason: "photo-gallery",
    test: (title) => /\bphotos?\s+(of|from)\s+the\s+week\b/i.test(title),
  },
  {
    // "Things to do this weekend", "What to do this week in Bend"
    reason: "events-listing",
    test: (title) =>
      /^(things\s+to\s+do|what('s|\s+to)\s+(do|see))\s+(this|next|in)\b/i.test(title),
  },
  {
    // Short body that is pure fundraising/about boilerplate, not news content.
    // Missing body is NOT a signal — keep those (wire/foreign feeds ship title-only).
    reason: "house-ad",
    test: (_title, body) => {
      if (!body || body.length > 400) return false;
      return /\b(member[\s-]supported|support\s+(our|public)\s+(media|journalism|radio|broadcasting)|sustaining\s+member|donate\s+today)\b/i.test(
        body
      );
    },
  },
  // ── Link-dump digests ──────────────────────────────────────────────────────
  //
  // A daily roundup is an index of other people's stories. It is worthless to a
  // reader whose paper exists to do that job, and it is actively harmful to the
  // ranking: its body is a dense list of exactly the topics he cares about, so
  // a relevance scorer reads it as the most relevant thing in the corpus. Run
  // #109 put Just Security's "Early Edition: August 10, 2026" at rank 9 in the
  // feature tier with the joint-highest singleton score in the paper.
  //
  // The prefilter prompt has said "cut link-dump roundups" since it was written
  // and did not catch these, so the guarantee lives here instead. Raising
  // prefilter's body_cap from 50 to 500 characters made the prompt's job harder,
  // not easier — more of the roundup's keyword-dense body now reaches the model.
  //
  // These patterns are drawn from observed run #109 rows, not written
  // speculatively. Each one targets an item whose *whole purpose* is to list
  // other articles; none of them can match a story that merely mentions a date
  // or a newsletter.
  {
    // Title is nothing but a date: "August 10, 2026", "10 August 2026".
    // A real headline says what happened; a date alone is a newsletter edition.
    reason: "link-dump-digest",
    test: (title) => {
      const t = title.trim();
      return (
        /^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}$/i.test(t) ||
        /^\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{4}$/i.test(t)
      );
    },
  },
  {
    // Known recurring digest mastheads, anchored at the start of the title and
    // required to be followed by a date or edition marker — so "The Download"
    // as a masthead is cut while an article titled "The download problem"
    // is not.
    reason: "link-dump-digest",
    test: (title) =>
      /^(early edition|the download|catch-up weekend|daily briefing|morning briefing|evening briefing|the daily brief|what we're reading|links? for|quick hits)\b\s*[:–—-]/i.test(
        title.trim(),
      ),
  },
  {
    // Digest boilerplate in the body. These phrases exist to introduce a list of
    // other people's stories; a report of a single event does not carry them.
    // Requires the body to be present — a title-only item never matches.
    reason: "link-dump-digest",
    test: (_title, body) => {
      if (!body) return false;
      const head = body.slice(0, 600);
      return (
        // "A curated guide to…" / "A curated weekday guide to…". The optional
        // qualifier matters: run #50's two Just Security editions differed by
        // exactly that word, and a rule without it would have caught one and
        // missed the other.
        /\ba curated\b[\w\s-]{0,20}\b(guide|roundup|list|digest)\b/i.test(head) ||
        /\bhere('s| is) (today's|this week's|the day's) news\b/i.test(head) ||
        /\bsign\s?up to receive the .{0,40}\bin your inbox\b/i.test(head) ||
        /\bcatch up on (today's|this week's|the week's)\b/i.test(head) ||
        // A newsletter announcing itself as an edition. Observed on MIT
        // Technology Review's The Download ("This is today's edition of The
        // Download, our weekday newsletter…") and STAT's Health Care Inc.
        // ("This is the online version of STAT's weekly email newsletter…").
        // The second of those survived run #50's rules and is the near-miss
        // this pattern exists for.
        /\bthis is (today's|the online version of|this week's|the web version of)\b.{0,80}\bnewsletter\b/i.test(
          head,
        )
      );
    },
  },
];

export function classifyItem(item: JunkFilterItem): ClassifyResult {
  for (const rule of RULES) {
    if (rule.test(item.title, item.body_text)) {
      return { keep: false, reason: rule.reason };
    }
  }
  return { keep: true };
}
