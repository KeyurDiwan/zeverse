export interface TemplateContext {
  inputs: Record<string, string>;
  steps: Record<string, { output: string }>;
}

export function renderTemplate(template: string, ctx: TemplateContext): string {
  return template.replace(/\{\{([\w.\-]+)\}\}/g, (_match, path: string) => {
    const parts = path.split(".");
    let current: any = ctx;
    for (const part of parts) {
      if (current == null || typeof current !== "object") return "";
      current = current[part];
    }
    if (current == null) return "";
    if (typeof current === "string") return current;
    if (typeof current === "number" || typeof current === "boolean") return String(current);
    return "";
  });
}
