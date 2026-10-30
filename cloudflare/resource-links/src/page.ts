import type { LinkRow, Provider } from "./types";

const names: Record<Provider, string> = {
  quark: "夸克网盘",
  baidu: "百度网盘",
  uc: "UC 网盘",
  xunlei: "迅雷网盘",
  guangya: "光鸭网盘",
  pikpak: "PikPak",
};

function escape(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );
}

const style = `
:root{color-scheme:only light;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#1d2b42;background:#fff;font-synthesis:none;-webkit-font-smoothing:antialiased;--blue:#2e61d5;--muted:#5d6c84;--line:#e1e7f0}
*{box-sizing:border-box}body{margin:0;min-height:100vh}::selection{background:#dce8ff;color:#1d2b42}
main{width:min(100% - 48px,680px);margin:0 auto;padding:64px 0 40px}header{display:flex;align-items:center;gap:10px;padding-bottom:32px;border-bottom:1px solid var(--line);font-size:15px;font-weight:600}
header svg{width:25px;height:25px;color:var(--blue);flex:none}article{padding:40px 0 32px}h1{margin:0 0 16px;font-size:28px;line-height:1.5;letter-spacing:-.02em;overflow-wrap:anywhere}p{line-height:1.8}p.platform{margin:0;color:var(--muted);font-size:15px}
.details{margin-top:32px;border-top:1px solid var(--line);padding-top:24px}.label{margin:0 0 8px;font-size:13px;color:var(--muted)}.link{margin:0;overflow-wrap:anywhere;font-size:15px;line-height:1.8;user-select:all}.code-row{display:flex;gap:16px;align-items:center;margin-top:24px}.code-row .label{margin:0}.code{font-weight:650;font-size:20px;letter-spacing:.1em;overflow-wrap:anywhere;user-select:all;min-width:0}
.actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:32px}a.button,button{font:inherit;font-size:14px;font-weight:500;line-height:1.5;border:1px solid #8090a8;border-radius:7px;min-height:42px;padding:10px 18px;cursor:pointer;background:#fff;color:#1d2b42;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;gap:8px}
a.primary{color:#fff;background:var(--blue);border-color:var(--blue)}a.primary:hover{background:#244eaf;border-color:#244eaf}button:hover{background:#f6f8fc}button:disabled{cursor:wait;color:var(--muted)}a:focus-visible,button:focus-visible{outline:3px solid #aac5ff;outline-offset:3px}.actions svg{width:17px;height:17px;flex:none}
.status{min-height:24px;margin:16px 0 0;font-size:13px;color:var(--muted)}.status[data-kind="success"]{color:#237a5e}.status[data-kind="error"]{color:#b9484e}.message{max-width:52ch;margin:12px 0 0;color:var(--muted);font-size:15px}footer{padding-top:24px;border-top:1px solid var(--line);font-size:12px;color:var(--muted);line-height:1.8}
`;

const script = `
for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    const status = document.getElementById('copy-status');
    const link = document.getElementById('share-link')?.textContent || '';
    const code = document.getElementById('share-code')?.textContent || '';
    const text = button.dataset.copy === 'code' ? code : link + (code ? '\\n提取码：' + code : '');
    button.disabled = true;
    try {
      await navigator.clipboard.writeText(text);
      status.textContent = button.dataset.copy === 'code' ? '提取码已复制。' : '分享链接' + (code ? '与提取码' : '') + '已复制。';
      status.dataset.kind = 'success';
    } catch {
      status.textContent = '复制未完成，请选中上方链接或提取码手动复制。';
      status.dataset.kind = 'error';
    } finally {
      button.disabled = false;
    }
  });
}
`;

const copyIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>`;
const openIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M14 3h7v7m0-7L10 14"/><path d="M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/></svg>`;

export function pageHeaders(nonce: string): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; connect-src 'none'`,
  };
}

export function renderPage(
  nonce: string,
  view: {
    row?: LinkRow;
    message?: string;
    title?: string;
    available?: boolean;
  },
): string {
  const row = view.row;
  const title = view.title ?? row?.title ?? "资源领取";
  const ready = Boolean(row && view.available);
  const details =
    ready && row
      ? `
    <section class="details" aria-label="网盘分享信息">
      <p class="label">当前分享链接</p><p class="link" id="share-link">${escape(row.target_url!)}</p>
      ${row.code ? `<div class="code-row"><span class="label">提取码</span><span class="code" id="share-code">${escape(row.code)}</span></div>` : ""}
      <div class="actions">
        <a class="button primary" href="/go/${escape(row.slug)}" target="_blank" rel="noopener noreferrer">${openIcon}打开网盘</a>
        <button type="button" data-copy="link">${copyIcon}${row.code ? "复制链接与提取码" : "复制链接"}</button>
        ${row.code ? `<button type="button" data-copy="code">复制提取码</button>` : ""}
      </div>
      <p class="status" id="copy-status" role="status" aria-live="polite"></p>
    </section>`
      : "";
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="robots" content="noindex,nofollow,noarchive"><title>${escape(title)} · 盘序</title><style nonce="${nonce}">${style}</style></head>
<body><main>
  <header><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M8 13h8m-4-4v8"/></svg>盘序资源</header>
  <article><h1>${escape(title)}</h1>${row ? `<p class="platform">${escape(names[row.provider])}</p>` : ""}${view.message ? `<p class="message">${escape(view.message)}</p>` : ""}${details}</article>
  <footer>${ready ? "文件保存在网盘中，点击“打开网盘”前往领取。" : "请联系分享者了解资源的最新状态。"}</footer>
</main>${ready ? `<script nonce="${nonce}">${script}</script>` : ""}</body></html>`;
}
