/**
 * Parse toolchain output for file/line hints (TypeScript, ESLint, Jest stack traces).
 */
export interface FailureLocation {
  file: string;
  line?: number;
  msg: string;
}

const TS_FILE_LINE = /^\s*([^\s()]+\.(?:tsx?|jsx?|mjs|cjs))(?:\((\d+),(\d+)\)|:(\d+):(\d+)):\s*(.+)$/im;
const STACK_FRAME = /\(([^()]+\.(?:tsx?|jsx?|mjs|cjs|py|go)):(\d+)(?::\d+)?\)/g;
const SIMPLE_FILE_LINE = /^\s*([^\s:]+\.(?:tsx?|jsx?|mjs|cjs)):(\d+)(?::(\d+))?\s*(.*)$/;

export function parseFailureLocations(output: string): FailureLocation[] {
  const out: FailureLocation[] = [];
  const seen = new Set<string>();

  function push(loc: FailureLocation): void {
    const key = `${loc.file}:${loc.line ?? 0}:${loc.msg.slice(0, 80)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(loc);
  }

  for (const line of output.split("\n")) {
    let m = line.match(TS_FILE_LINE);
    if (m) {
      const file = m[1]!;
      const ln = parseInt(m[2] || m[4] || "", 10);
      const msg = (m[6] || m[3] || "").trim();
      push({ file, line: Number.isFinite(ln) ? ln : undefined, msg: msg || line.trim() });
      continue;
    }
    m = line.match(SIMPLE_FILE_LINE);
    if (m && !line.includes("http://") && !line.includes("https://")) {
      const file = m[1]!;
      const ln = parseInt(m[2]!, 10);
      const rest = (m[4] ?? "").trim();
      push({ file, line: ln, msg: rest || line.trim() });
    }
  }

  let sm: RegExpExecArray | null;
  const re = new RegExp(STACK_FRAME.source, STACK_FRAME.flags);
  while ((sm = re.exec(output)) != null) {
    const file = sm[1]!;
    const ln = parseInt(sm[2]!, 10);
    push({ file, line: ln, msg: "stack frame" });
  }

  return out.slice(0, 40);
}

export function formatStructuredFailuresFooter(locations: FailureLocation[]): string {
  if (locations.length === 0) return "";
  const lines = locations.map(
    (l) =>
      `file=${l.file}${l.line != null ? ` line=${l.line}` : ""} msg=${JSON.stringify(l.msg.slice(0, 400))}`
  );
  return `\n\n--- ZEVERSE_STRUCTURED_FAILURES ---\n${lines.join("\n")}\n`;
}

export function extractStructuredFailuresBlock(output: string): FailureLocation[] {
  const marker = "--- ZEVERSE_STRUCTURED_FAILURES ---";
  const idx = output.lastIndexOf(marker);
  if (idx === -1) return [];
  const body = output.slice(idx + marker.length).trim();
  const locs: FailureLocation[] = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("file=")) continue;
    let file = "";
    let lineNum: number | undefined;
    let msg = "";
    const parts = trimmed.split(/\s+/);
    for (const p of parts) {
      if (p.startsWith("file=")) file = p.slice(5);
      else if (p.startsWith("line=")) lineNum = parseInt(p.slice(5), 10);
      else if (p.startsWith("msg=")) {
        msg = p.slice(4);
        try {
          msg = JSON.parse(msg) as string;
        } catch {
          /* keep raw */
        }
      }
    }
    if (file) locs.push({ file, line: Number.isFinite(lineNum!) ? lineNum : undefined, msg });
  }
  return locs;
}

/** Merge failure-derived keywords into retrieval query text. */
export function augmentQueryWithFailures(query: string, locs: FailureLocation[]): string {
  if (locs.length === 0) return query;
  const bits = locs.map((l) => `${l.file}${l.line != null ? `:${l.line}` : ""} ${l.msg}`).join("\n");
  return `${query}\n\n## Related failures\n${bits}`;
}
