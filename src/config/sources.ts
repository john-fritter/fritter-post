import { readFileSync } from "fs";
import path from "path";
import { parse } from "yaml";
import { z } from "zod";

const SourceSchema = z.object({
  name: z.string(),
  url: z.string().url(),
  type: z.enum(["wire", "journalism", "advocacy", "newsletter"]),
  notes: z.string().optional(),
  parent: z.string().optional(),
});

export type Source = z.infer<typeof SourceSchema>;

const SourcesSchema = z.array(SourceSchema);

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
  cached = SourcesSchema.parse(parse(raw));
  return cached;
}
