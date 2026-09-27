import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * Memory v2 (阶段 9.5): Markdown is the single source of authority.
 * One Ordinary Memory = one .md file with YAML frontmatter + structured body;
 * SQLite holds only derived, rebuildable indexes (FTS5 now, vectors in 9.6).
 */

export interface MemoryRecord {
  id: string;
  runId: string;
  taskType: string;
  outcome: "success" | "partial" | "failed";
  summaryEn: string;
  summaryZh: string;
  approach: string;
  pitfalls: string;
  keywordsEn: string[];
  confirmations: number;
  model?: string;
  created: string;
  updated: string;
}

const FRONTMATTER_FIELDS = [
  "id",
  "runId",
  "taskType",
  "outcome",
  "keywords",
  "confirmations",
  "model",
  "created",
  "updated",
] as const;

/** 阶段 13 (P1-1): memory ids become file names — same slug rule as skill names. */
export const MEMORY_ID_PATTERN = /^[a-z0-9-]{1,64}$/;

export function serializeMemory(record: MemoryRecord): string {
  const frontmatter = stringifyYaml({
    id: record.id,
    runId: record.runId,
    taskType: record.taskType,
    outcome: record.outcome,
    keywords: record.keywordsEn,
    confirmations: record.confirmations,
    model: record.model,
    created: record.created,
    updated: record.updated,
  });
  const body = [
    `# ${record.summaryEn}`,
    "",
    "## 中文摘要",
    record.summaryZh,
    "",
    "## Approach",
    record.approach,
    "",
    "## Pitfalls",
    record.pitfalls,
    "",
  ].join("\n");
  return `---\n${frontmatter}---\n${body}`;
}

export function parseMemory(raw: string, source: string): MemoryRecord {
  if (!raw.startsWith("---")) throw new Error(`${source}: missing frontmatter`);
  const end = raw.indexOf("\n---", 3);
  if (end === -1) throw new Error(`${source}: unterminated frontmatter`);
  const meta = (parseYaml(raw.slice(3, end)) ?? {}) as Record<string, unknown>;
  // 阶段 13 (P1-1): the id becomes a file path — validate it BEFORE the
  // completeness checks so a hostile id is never waved through on a
  // missing-field technicality.
  if (meta.id !== undefined && !MEMORY_ID_PATTERN.test(String(meta.id))) {
    throw new Error(`${source}: invalid id "${String(meta.id)}" (must match ${MEMORY_ID_PATTERN})`);
  }
  for (const field of FRONTMATTER_FIELDS) {
    if (!(field in meta)) throw new Error(`${source}: frontmatter missing "${field}"`);
  }
  const body = raw.slice(raw.indexOf("\n", end + 1) + 1);
  const section = (title: string): string => {
    const match = body.match(new RegExp(`## ${title}\\r?\\n([\\s\\S]*?)(?=\\n## |$)`));
    return match?.[1]?.trim() ?? "";
  };
  const outcome = String(meta.outcome);
  const id = String(meta.id);
  if (!MEMORY_ID_PATTERN.test(id)) throw new Error(`${source}: invalid id "${id}" (must match ${MEMORY_ID_PATTERN})`);
  return {
    id,
    runId: String(meta.runId),
    taskType: String(meta.taskType),
    outcome: outcome === "success" || outcome === "partial" || outcome === "failed" ? outcome : "partial",
    summaryEn: (body.match(/^# (.+)$/m)?.[1] ?? "").trim(),
    summaryZh: section("中文摘要"),
    approach: section("Approach"),
    pitfalls: section("Pitfalls"),
    keywordsEn: Array.isArray(meta.keywords) ? meta.keywords.map(String) : [],
    confirmations: Number(meta.confirmations ?? 0),
    model: meta.model == null ? undefined : String(meta.model),
    created: String(meta.created),
    updated: String(meta.updated),
  };
}
