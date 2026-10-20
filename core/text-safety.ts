// Chinese prose often joins a URL and its next sentence without whitespace.
// Stop at prose punctuation while still allowing non-ASCII URL paths.
const urlPattern =
  /https?:\/\/[^\s<>"'，。；！？、（）【】《》“”‘’「」『』\]\)]+|www\.[^\s<>"'，。；！？、（）【】《》“”‘’「」『』\]\)]+/gi;

export function redactLinks(text: string, replacement = "[链接已省略]") {
  return text.replace(urlPattern, replacement);
}

export function redactPromptText(text: string) {
  return redactLinks(text).replace(
    /sk-(?:or-v1-)?[a-zA-Z0-9_-]{12,}|Bearer\s+[^\s,，;；。！？]+|(?:cookie|api[_ -]?key|password|提取码|访问码)\s*[:：=]\s*[^\s,，;；。！？]+|(?:提取码|访问码|密码)\s*[:：]?\s*[a-zA-Z0-9]{4,8}/gi,
    "[凭据已省略]",
  );
}

// Only supplied metadata is scrubbed. Model settings, output schemas and image
// attachments are constructed separately and keep their original structures.
export function redactPromptInput(value: unknown): unknown {
  if (typeof value === "string") return redactPromptText(value);
  if (Array.isArray(value)) return value.map(redactPromptInput);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        redactPromptInput(entry),
      ]),
    );
  return value;
}
