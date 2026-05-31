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
];

export function classifyItem(item: JunkFilterItem): ClassifyResult {
  for (const rule of RULES) {
    if (rule.test(item.title, item.body_text)) {
      return { keep: false, reason: rule.reason };
    }
  }
  return { keep: true };
}
