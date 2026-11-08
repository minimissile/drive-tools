const escape = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
function inline(text: string, allowImage?: (url: URL) => boolean) {
  const tokens: string[] = [];
  const hold = (html: string) => `\u0000${tokens.push(html) - 1}\u0000`;
  const prepared = text
    .replace(/`([^`\n]+)`/g, (_all, code) =>
      hold(`<code>${escape(code)}</code>`),
    )
    .replace(
      /!\[([^\]]*)\]\(((?:https:|panxu-media:)\/\/[^\s)]+)\)/g,
      (_all, alt, raw) => {
        try {
          const u = new URL(raw);
          if (
            !(allowImage
              ? allowImage(u)
              : u.protocol === "https:" &&
                /^(?:mmbiz\.(?:qpic|qlogo)\.cn|(?:[\w-]+\.)?(?:smzdm\.com|zdmimg\.com))$/.test(
                  u.hostname,
                )) ||
            u.username ||
            u.password ||
            u.port
          )
            return alt;
          return hold(`<img src="${escape(u.href)}" alt="${escape(alt)}">`);
        } catch {
          return escape(alt);
        }
      },
    )
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
  const restore = (value: string): string =>
    value.replace(/\u0000(\d+)\u0000/g, (_, i) =>
      restore(tokens[Number(i)] ?? ""),
    );
  return restore(
    escape(prepared).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>"),
  );
}
/** Only app-generated markup reaches the publishing editor; source HTML is never executed. */
export function articleHtml(body: string, allowImage?: (url: URL) => boolean) {
  let code = false;
  let list: "ul" | "ol" | null = null;
  const closeList = () => {
    const closing = list ? `</${list}>` : "";
    list = null;
    return closing;
  };
  return (
    body
      .replace(/\u0000/g, "")
      .split("\n")
      .map((line) => {
        if (/^```/.test(line)) {
          code = !code;
          return closeList() + (code ? "<pre><code>" : "</code></pre>");
        }
        if (code) return escape(line);
        if (!line.trim()) return "";
        if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line))
          return closeList() + "<hr>";
        const ordered = line.match(/^\s{0,3}(\d{1,9})[.)]\s+(.+)$/);
        const unordered = line.match(/^\s{0,3}[-+*]\s+(.+)$/);
        if (ordered || unordered) {
          const type = ordered ? "ol" : "ul";
          let opening = "";
          if (list !== type) {
            opening = closeList();
            const start = ordered ? Number(ordered[1]) : 1;
            opening +=
              type === "ol" && start !== 1
                ? `<ol start="${start}">`
                : `<${type}>`;
            list = type;
          }
          return `${opening}<li>${inline(ordered ? ordered[2] : unordered![1], allowImage)}</li>`;
        }
        const closing = closeList();
        const heading = line.match(/^(#{1,6})\s+(.+)$/);
        if (heading) {
          const level = Math.min(heading[1].length + 1, 6);
          return `${closing}<h${level}>${inline(heading[2], allowImage)}</h${level}>`;
        }
        if (/^>\s?/.test(line))
          return `${closing}<blockquote>${inline(line.replace(/^>\s?/, ""), allowImage)}</blockquote>`;
        return `${closing}<p>${inline(line, allowImage)}</p>`;
      })
      .join("\n") +
    closeList() +
    (code ? "</code></pre>" : "")
  );
}
