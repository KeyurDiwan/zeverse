import { isConfluenceUrl } from "./integrations/confluence";

function isGoogleDocUrlText(text: string): boolean {
  return (
    /docs\.google\.com\/document\/d\//.test(text) || /drive\.google\.com\/.*\/d\//.test(text)
  );
}

/** First Google Docs or Confluence URL in free text (Slack mentions, harness prompts). */
export function extractPrdDocUrl(text: string): string | undefined {
  const urls = text.match(/https?:\/\/[^\s<>\]]+/gi) ?? [];
  for (let u of urls) {
    u = u.replace(/[),.;]+$/g, "");
    if (isGoogleDocUrlText(u) || isConfluenceUrl(u)) return u;
  }
  return undefined;
}
