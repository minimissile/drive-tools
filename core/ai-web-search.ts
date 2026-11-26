/** Only provider-returned citations count as retrieved evidence, never model-written URLs. */
export interface AiWebSource {
  url: string;
  title: string;
  content: string;
}
export function aiWebSources(annotations: unknown): AiWebSource[] {
  if (!Array.isArray(annotations)) return [];
  const sources = new Map<string, AiWebSource>();
  for (const annotation of annotations.slice(0, 30)) {
    if (annotation?.type !== "url_citation") continue;
    const citation = annotation.url_citation;
    if (typeof citation?.url !== "string") continue;
    try {
      const url = new URL(citation.url);
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        continue;
      if (
        url.href.length > 2000 ||
        typeof citation.content !== "string" ||
        !citation.content.trim()
      )
        continue;
      sources.set(url.href, {
        url: url.href,
        title:
          typeof citation.title === "string"
            ? citation.title.slice(0, 200)
            : url.hostname,
        content: citation.content.slice(0, 6000),
      });
    } catch {
      /* An invalid citation cannot support a fact. */
    }
  }
  return [...sources.values()].slice(0, 10);
}

// Exa auto: $0.007/request, five results. Reserve room for injected search text
// as well as the fixed search fee; reconcile to usage.cost as for other AI calls.
export const aiWebSearchFeeMicros = 7000;
export const aiWebSearchPromptAllowance = 60_000;
