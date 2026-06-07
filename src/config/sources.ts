import { readFileSync } from "fs";
import path from "path";
import { parse } from "yaml";
import { z } from "zod";

const RawSourceSchema = z.object({
  name: z.string(),
  url: z.string().url(),
  type: z.enum(["wire", "journalism", "advocacy", "newsletter"]),
  track: z.string().optional(),
  group: z.string().optional(),
  notes: z.string().optional(),
  parent: z.string().optional(),
});

type RawSource = z.infer<typeof RawSourceSchema>;

const RawSourcesSchema = z.array(RawSourceSchema);

export type Source = Omit<RawSource, "track" | "group"> & {
  track: "news" | "analysis";
  group: string | null;
};

const SOURCES_PATH = path.join(
  import.meta.dirname,
  "..",
  "..",
  "config",
  "sources.yaml"
);

let cached: Source[] | null = null;

export function loadSources(): Source[] {
  if (cached) return cached;
  const raw = readFileSync(SOURCES_PATH, "utf-8");
  const parsed: RawSource[] = RawSourcesSchema.parse(parse(raw));
  cached = parsed.map((s) => {
    let track: "news" | "analysis" = "news";
    if (s.track === "news" || s.track === "analysis") {
      track = s.track;
    } else if (s.track !== undefined) {
      console.warn(
        `[sources] unknown track "${s.track}" for source "${s.name}" — defaulting to "news"`
      );
    }
    return { ...s, track, group: s.group ?? null };
  });
  return cached;
}
