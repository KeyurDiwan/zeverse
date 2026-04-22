export interface TemplateContext {
  inputs: Record<string, string>;
  steps: Record<string, { output: string }>;
}

export function renderTemplate(template: string, ctx: TemplateContext): string {
  return template.replace(/\{\{([\w.]+)\}\}/g, (match, path: string) => {
    const parts = path.split(".");
    let current: any = ctx;
    for (const part of parts) {
      if (current == null || typeof current !== "object") return match;
      current = current[part];
    }
    return typeof current === "string" ? current : match;
  });
}
