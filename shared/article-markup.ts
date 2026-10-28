const escape = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
function inline(text: string) {
  const tokens: string[] = [];
  const hold = (html: string) => `\u0000${tokens.push(html) - 1}\u0000`;
  const prepared = text
    .replace(/!\[([^\]]*)\]\((https:\/\/[^\s)]+)\)/g, (_all, alt, raw) => {
      try {
        const u = new URL(raw);
        if (
          !/^(?:mmbiz\.(?:qpic|qlogo)\.cn|(?:[\w-]+\.)?(?:smzdm\.com|zdmimg\.com))$/.test(
            u.hostname,
          ) ||
          u.username ||
          u.password ||
          u.port
        )
          return alt;
        return hold(`<img src="${escape(u.href)}" alt="${escape(alt)}">`);
      } catch {
        return escape(alt);
      }
    })
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_all, label, raw) => {
      try {
        const u = new URL(raw);
        if (u.username || u.password || u.port) return label;
        return hold(
          `<a href="${escape(u.href)}" rel="noopener noreferrer">${escape(label)}</a>`,
        );
      } catch {
        return label;
      }
    })
    .replace(/https?:\/\/[^\s<>"'，。；）)\]]+/gi, (raw) => {
      try {
        const url = new URL(raw);
        if (url.username || url.password || url.port) return raw;
        return hold(
          `<a href="${escape(url.href)}" rel="noopener noreferrer">${escape(raw)}</a>`,
        );
      } catch {
        return raw;
      }
    });
  return escape(prepared)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\u0000(\d+)\u0000/g, (_, i) => tokens[Number(i)] ?? "");
}
/** Only app-generated markup reaches the publishing editor; source HTML is never executed. */
export function articleHtml(body: string) {
  let code = false;
  return (
    body
      .replace(/\u0000/g, "")
      .split("\n")
      .map((line) => {
        if (/^```/.test(line)) {
          code = !code;
          return code ? "<pre><code>" : "</code></pre>";
        }
        if (code) return escape(line) + "\n";
        const heading = line.match(/^(#{1,6})\s+(.+)$/);
        if (heading) {
          const level = Math.min(heading[1].length + 1, 6);
          return `<h${level}>${inline(heading[2])}</h${level}>`;
        }
        if (!line.trim()) return "";
        if (/^>\s?/.test(line))
          return `<blockquote>${inline(line.replace(/^>\s?/, ""))}</blockquote>`;
        return `<p>${inline(line)}</p>`;
      })
      .join("\n") + (code ? "</code></pre>" : "")
  );
}
