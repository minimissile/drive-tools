const credentialField =
  /^(authorization|cookie|set-cookie|access_token|refresh_token|api[_-]?key|password|secret|token)$/i;
// The archive keeps the complete response data, excluding authentication material.
export function cleanKnowledge(value: unknown, secret = ""): unknown {
  if (typeof value === "string")
    return (secret ? value.split(secret).join("[凭据已隐藏]") : value)
      .replace(/Bearer\s+[^\s,;"'}]+/gi, "Bearer [凭据已隐藏]")
      .replace(/sk-(?:or-v1-)?[a-zA-Z0-9_-]{12,}/g, "[凭据已隐藏]")
      .replace(
        /((?:authorization|cookie|api[_-]?key|access_token|refresh_token)["']?\s*[:=]\s*["']?)[^\s,;"'}]+/gi,
        "$1[凭据已隐藏]",
      );
  if (Array.isArray(value)) return value.map((v) => cleanKnowledge(v, secret));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        credentialField.test(k) ? "[凭据已隐藏]" : cleanKnowledge(v, secret),
      ]),
    );
  return value;
}
