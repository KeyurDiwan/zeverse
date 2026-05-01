import fs from "fs";
import path from "path";
import Parser from "tree-sitter";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const TsGrammar = require("tree-sitter-typescript") as {
  typescript: unknown;
  tsx: unknown;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const JavaScript = require("tree-sitter-javascript") as unknown;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Python = require("tree-sitter-python") as unknown;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Go = require("tree-sitter-go") as unknown;

export interface ExtractedChunk {
  symbol: string | null;
  kind: string;
  startLine: number;
  endLine: number;
  language: string;
  content: string;
  /** Definitions for symbol table */
  symbols: Array<{ name: string; kind: string }>;
  /** Import module paths (resolved relative paths when possible) */
  importPaths: string[];
  /** Callee identifiers referenced inside this chunk */
  calls: string[];
}

const DECL_CHUNK_TYPES = new Set([
  "function_declaration",
  "generator_function",
  "method_definition",
  "class_declaration",
  "interface_declaration",
  "type_alias_declaration",
  "enum_declaration",
  "lexical_declaration",
]);

function lineRange(source: string, startIdx: number, endIdx: number): { startLine: number; endLine: number } {
  const startLine = source.slice(0, startIdx).split("\n").length;
  const endLine = source.slice(0, endIdx).split("\n").length;
  return { startLine, endLine };
}

function nodeText(source: string, n: Parser.SyntaxNode): string {
  return source.slice(n.startIndex, n.endIndex);
}

function childIdentifier(n: Parser.SyntaxNode, field: string): Parser.SyntaxNode | null {
  const c = n.childForFieldName(field);
  return c && c.type === "identifier" ? c : null;
}

function declarationName(n: Parser.SyntaxNode, source: string): string | null {
  const nameField = n.childForFieldName("name");
  if (nameField?.type === "identifier") return nodeText(source, nameField).trim() || null;

  const id =
    childIdentifier(n, "name") ??
    childIdentifier(n, "declarator")?.childForFieldName("name") ??
    null;
  if (id) return nodeText(source, id).trim() || null;

  if (n.type === "lexical_declaration") {
    const decl = n.namedChildren.find((c) => c.type === "variable_declarator");
    if (decl) {
      const name = decl.childForFieldName("name");
      if (name?.type === "identifier") return nodeText(source, name);
    }
  }
  return null;
}

function extractCalleeName(call: Parser.SyntaxNode, source: string): string | null {
  const fn = call.childForFieldName("function");
  if (!fn) return null;
  if (fn.type === "identifier") return nodeText(source, fn);
  if (fn.type === "member_expression") {
    const prop = fn.childForFieldName("property");
    if (prop?.type === "property_identifier" || prop?.type === "identifier") {
      return nodeText(source, prop);
    }
  }
  return null;
}

function collectCalls(n: Parser.SyntaxNode, source: string, into: Set<string>): void {
  const stack: Parser.SyntaxNode[] = [n];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur.type === "call_expression") {
      const name = extractCalleeName(cur, source);
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) into.add(name);
    }
    for (const c of cur.namedChildren) stack.push(c);
  }
}

function parseImportModule(specNode: Parser.SyntaxNode | null, source: string): string | null {
  if (!specNode) return null;
  const stripQuotes = (s: string) => s.replace(/^['"`]|['"`]$/g, "");

  if (specNode.type === "string_fragment") {
    return stripQuotes(nodeText(source, specNode));
  }
  if (specNode.type === "string") {
    const frag = specNode.namedChildren.find((x) => x.type === "string_fragment");
    if (frag) return stripQuotes(nodeText(source, frag));
  }
  // call_expression require("x")
  if (specNode.type === "call_expression") {
    const args = specNode.childForFieldName("arguments");
    const first = args?.namedChildren[0];
    if (first) return parseImportModule(first, source);
  }
  return null;
}

function collectImports(root: Parser.SyntaxNode, source: string): string[] {
  const mods: string[] = [];
  const stack: Parser.SyntaxNode[] = [root];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur.type === "import_statement") {
      const src = cur.childForFieldName("source");
      const m = parseImportModule(src, source);
      if (m) mods.push(m);
    }
    if (cur.type === "call_expression") {
      const fn = cur.childForFieldName("function");
      const args = cur.childForFieldName("arguments");
      if (
        fn?.type === "identifier" &&
        nodeText(source, fn) === "require" &&
        args?.namedChildren.length
      ) {
        const m = parseImportModule(args.namedChildren[0]!, source);
        if (m) mods.push(m);
      }
    }
    for (const c of cur.namedChildren) stack.push(c);
  }
  return mods;
}

export function resolveTsJsImport(fromFilePosix: string, specifier: string): string | null {
  const spec = specifier.trim();
  if (!spec.startsWith(".") && !spec.startsWith("/")) return null;
  const dir = path.posix.dirname(fromFilePosix);
  let joined = path.posix.normalize(path.posix.join(dir, spec));
  if (joined.startsWith("/")) joined = joined.slice(1);
  return joined;
}

export function resolveImportToExistingPath(
  repoRoot: string,
  fromFilePosix: string,
  specifier: string
): string | null {
  const base = resolveTsJsImport(fromFilePosix, specifier);
  if (!base) return null;
  const candidates = [
    base,
    base + ".ts",
    base + ".tsx",
    base + ".js",
    base + ".jsx",
    base + ".mjs",
    base + "/index.ts",
    base + "/index.tsx",
    base + "/index.js",
  ];
  for (const rel of candidates) {
    const abs = path.join(repoRoot, ...rel.split("/"));
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return rel;
  }
  return base;
}

function splitOversizedClass(
  cls: Parser.SyntaxNode,
  source: string,
  maxLines: number
): Parser.SyntaxNode[] {
  const span = cls.endIndex - cls.startIndex;
  const lines = source.slice(cls.startIndex, cls.endIndex).split("\n").length;
  if (lines <= maxLines) return [cls];

  const methods = cls.namedChildren.filter((c) =>
    ["method_definition", "public_field_definition"].includes(c.type)
  );
  if (methods.length === 0) return [cls];

  const parts: Parser.SyntaxNode[] = [];
  let curHead = cls.startIndex;
  for (const m of methods) {
    if (m.startIndex > curHead) {
      // preamble (class signature opening)
      const preambleEnd = m.startIndex;
      const preLines = source.slice(curHead, preambleEnd).split("\n").length;
      if (preLines >= 3) {
        // synthetic not a node — keep whole class if splitting fails
      }
    }
    parts.push(m);
  }
  return parts.length ? parts : [cls];
}

function chunkJsLikeTree(
  root: Parser.SyntaxNode,
  source: string,
  lang: string,
  maxLines: number,
  fileImportsResolved: string[]
): ExtractedChunk[] {
  const chunks: ExtractedChunk[] = [];

  function emitNode(n: Parser.SyntaxNode, kindOverride?: string): void {
    const text = nodeText(source, n);
    const lines = text.split("\n").length;
    if (lines > maxLines && n.type === "class_declaration") {
      for (const part of splitOversizedClass(n, source, maxLines)) {
        emitNode(part, "class_member");
      }
      return;
    }
    if (lines > maxLines) {
      // sliding window by lines
      const rawLines = text.split("\n");
      for (let i = 0; i < rawLines.length; i += maxLines) {
        const slice = rawLines.slice(i, i + maxLines).join("\n");
        const startIdx = n.startIndex + rawLines.slice(0, i).join("\n").length + (i > 0 ? 1 : 0);
        const endIdx = startIdx + slice.length;
        const lr = lineRange(source, startIdx, endIdx);
        const calls = new Set<string>();
        collectCalls(n, source, calls);
        chunks.push({
          symbol: null,
          kind: `${n.type}_window`,
          startLine: lr.startLine,
          endLine: lr.endLine,
          language: lang,
          content: slice,
          symbols: [],
          importPaths: [...fileImportsResolved],
          calls: [...calls],
        });
      }
      return;
    }

    const lr = lineRange(source, n.startIndex, n.endIndex);
    const name = declarationName(n, source);
    const calls = new Set<string>();
    collectCalls(n, source, calls);
    const syms: Array<{ name: string; kind: string }> = [];
    if (name) syms.push({ name, kind: n.type });

    chunks.push({
      symbol: name,
      kind: kindOverride ?? n.type,
      startLine: lr.startLine,
      endLine: lr.endLine,
      language: lang,
      content: text,
      symbols: syms,
      importPaths: [...fileImportsResolved],
      calls: [...calls],
    });
  }

  const body =
    root.type === "program"
      ? root
      : root.namedChildren.find((c) => c.type === "program") ?? root;

  for (const child of body.namedChildren) {
    if (DECL_CHUNK_TYPES.has(child.type)) {
      emitNode(child);
    } else if (child.type === "export_statement") {
      const inner = child.namedChildren[0];
      if (inner && DECL_CHUNK_TYPES.has(inner.type)) emitNode(inner);
    }
  }

  if (chunks.length === 0) {
    emitNode(body);
  }

  return chunks;
}

function chunkPython(root: Parser.SyntaxNode, source: string, maxLines: number): ExtractedChunk[] {
  const chunks: ExtractedChunk[] = [];
  const body =
    root.type === "module"
      ? root
      : root.namedChildren.find((c) => c.type === "module") ?? root;

  for (const child of body.namedChildren) {
    if (["function_definition", "class_definition"].includes(child.type)) {
      const text = nodeText(source, child);
      const lr = lineRange(source, child.startIndex, child.endIndex);
      const nameNode = child.childForFieldName("name");
      const name = nameNode ? nodeText(source, nameNode) : null;
      const calls = new Set<string>();
      collectCalls(child, source, calls);
      chunks.push({
        symbol: name,
        kind: child.type,
        startLine: lr.startLine,
        endLine: lr.endLine,
        language: "python",
        content: text,
        symbols: name ? [{ name, kind: child.type }] : [],
        importPaths: [],
        calls: [...calls],
      });
    }
  }

  if (chunks.length === 0) {
    const lr = lineRange(source, 0, source.length);
    chunks.push({
      symbol: null,
      kind: "module",
      startLine: lr.startLine,
      endLine: lr.endLine,
      language: "python",
      content: source.slice(0, 8000),
      symbols: [],
      importPaths: [],
      calls: [],
    });
  }
  return chunks;
}

function chunkGo(root: Parser.SyntaxNode, source: string, maxLines: number): ExtractedChunk[] {
  const chunks: ExtractedChunk[] = [];
  const pkg =
    root.type === "source_file"
      ? root
      : root.namedChildren.find((c) => c.type === "source_file") ?? root;

  for (const child of pkg.namedChildren) {
    if (child.type === "function_declaration" || child.type === "method_declaration") {
      const text = nodeText(source, child);
      const lr = lineRange(source, child.startIndex, child.endIndex);
      const nameNode = child.childForFieldName("name");
      const name = nameNode ? nodeText(source, nameNode) : null;
      const calls = new Set<string>();
      collectCalls(child, source, calls);
      chunks.push({
        symbol: name,
        kind: child.type,
        startLine: lr.startLine,
        endLine: lr.endLine,
        language: "go",
        content: text,
        symbols: name ? [{ name, kind: child.type }] : [],
        importPaths: [],
        calls: [...calls],
      });
    }
  }

  if (chunks.length === 0) {
    const lr = lineRange(source, 0, Math.min(source.length, 8000));
    chunks.push({
      symbol: null,
      kind: "file",
      startLine: 1,
      endLine: lr.endLine,
      language: "go",
      content: source.slice(0, 8000),
      symbols: [],
      importPaths: [],
      calls: [],
    });
  }
  return chunks;
}

function chunkMarkdown(source: string, maxLines: number): ExtractedChunk[] {
  const lines = source.split("\n");
  const chunks: ExtractedChunk[] = [];
  let buf: string[] = [];
  let startLine = 1;

  function flush(endLine: number): void {
    if (buf.length === 0) return;
    const content = buf.join("\n");
    chunks.push({
      symbol: null,
      kind: "markdown_section",
      startLine,
      endLine,
      language: "markdown",
      content,
      symbols: [],
      importPaths: [],
      calls: [],
    });
    buf = [];
  }

  let lineNo = 1;
  for (const line of lines) {
    if (line.match(/^#{1,6}\s/) && buf.length > 0 && buf.join("\n").split("\n").length >= maxLines / 4) {
      flush(lineNo - 1);
      startLine = lineNo;
    }
    buf.push(line);
    if (buf.join("\n").split("\n").length >= maxLines) {
      flush(lineNo);
      startLine = lineNo + 1;
    }
    lineNo++;
  }
  flush(lineNo - 1);
  if (chunks.length === 0) {
    chunks.push({
      symbol: null,
      kind: "markdown",
      startLine: 1,
      endLine: Math.max(1, lines.length),
      language: "markdown",
      content: source.slice(0, 12000),
      symbols: [],
      importPaths: [],
      calls: [],
    });
  }
  return chunks;
}

function fallbackLineChunks(source: string, lang: string, maxLines: number): ExtractedChunk[] {
  const lines = source.split("\n");
  const out: ExtractedChunk[] = [];
  for (let i = 0; i < lines.length; i += maxLines) {
    const slice = lines.slice(i, i + maxLines).join("\n");
    out.push({
      symbol: null,
      kind: "line_window",
      startLine: i + 1,
      endLine: Math.min(i + maxLines, lines.length),
      language: lang,
      content: slice,
      symbols: [],
      importPaths: [],
      calls: [],
    });
  }
  return out.length ? out : [{ symbol: null, kind: "empty", startLine: 1, endLine: 1, language: lang, content: "", symbols: [], importPaths: [], calls: [] }];
}

export function extractChunks(
  repoRoot: string,
  relPathPosix: string,
  source: string,
  maxLines: number
): ExtractedChunk[] {
  const ext = path.posix.extname(relPathPosix).toLowerCase();
  const parser = new Parser();

  const rawImports: string[] = [];
  let chunks: ExtractedChunk[] = [];

  try {
    if ([".md"].includes(ext)) {
      return chunkMarkdown(source, maxLines);
    }

    if ([".ts"].includes(ext)) {
      parser.setLanguage(TsGrammar.typescript);
    } else if ([".tsx"].includes(ext)) {
      parser.setLanguage(TsGrammar.tsx);
    } else if ([".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
      parser.setLanguage(JavaScript);
    } else if ([".py"].includes(ext)) {
      parser.setLanguage(Python);
      const tree = parser.parse(source);
      return chunkPython(tree.rootNode, source, maxLines);
    } else if ([".go"].includes(ext)) {
      parser.setLanguage(Go);
      const tree = parser.parse(source);
      return chunkGo(tree.rootNode, source, maxLines);
    } else {
      return fallbackLineChunks(source, ext.slice(1) || "text", maxLines);
    }

    const tree = parser.parse(source);
    const root = tree.rootNode;
    const collected = collectImports(root, source);
    for (const m of collected) {
      const resolved = resolveImportToExistingPath(repoRoot, relPathPosix, m);
      if (resolved) rawImports.push(resolved);
    }

    const lang =
      ext === ".tsx" ? "tsx" : ext === ".ts" ? "typescript" : ext.replace(".", "") || "javascript";
    chunks = chunkJsLikeTree(root, source, lang, maxLines, rawImports);
  } catch {
    chunks = fallbackLineChunks(source, ext.slice(1) || "text", maxLines);
  }

  return chunks;
}
