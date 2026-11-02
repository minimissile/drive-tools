export const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export const jsonLd = (value: unknown) =>
  JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
export const providerNames: Record<string, string> = {
  quark: "夸克网盘",
  baidu: "百度网盘",
  uc: "UC 网盘",
  xunlei: "迅雷网盘",
  guangya: "光鸭网盘",
  pikpak: "PikPak",
};
export function fileSize(value: number | null) {
  if (value == null) return "大小未记录";
  if (value < 1024) return `${value} B`;
  if (value < 1048576) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1048576).toFixed(1)} MB`;
}
export const calendar = (value: string) => value.slice(0, 10);
export const siteStyle = `
:root{color-scheme:only light;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;font-synthesis:none;-webkit-font-smoothing:antialiased;color:#1d2b42;background:#fff;--blue:#2e61d5;--muted:#586981;--line:#dfe6ef;--wash:#f5f7fb}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:24px}body{margin:0}::selection{color:#172b50;background:#dce8ff}a{color:var(--blue);text-underline-offset:4px}a:hover{text-decoration:underline}button,input{font:inherit}button,a,input{ -webkit-tap-highlight-color:transparent}a:focus-visible,button:focus-visible,input:focus-visible,summary:focus-visible{outline:3px solid #92b5ff;outline-offset:3px}input{caret-color:var(--blue)}
.site-header,.site-footer,.site-main{width:min(1120px,calc(100% - 64px));margin-inline:auto}.site-header{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:24px 0;border-bottom:1px solid var(--line)}.brand{font-size:20px;font-weight:750;letter-spacing:-.02em;color:#1d2b42;text-decoration:none}.brand span{font-weight:400;font-size:14px;color:var(--muted);margin-left:12px}.site-nav{display:flex;gap:24px;font-size:14px}.site-nav a{color:var(--muted);text-decoration:none}.site-nav a:hover{color:var(--blue)}.site-main{padding:32px 0 64px}.site-footer{display:flex;justify-content:space-between;flex-wrap:wrap;gap:16px;border-top:1px solid var(--line);padding:24px 0 36px;color:var(--muted);font-size:12px;line-height:1.8}.site-footer p{margin:0}.site-footer a{color:inherit}
h1,h2,h3,p{margin-top:0}h1{font-size:34px;line-height:1.4;letter-spacing:-.025em;font-weight:720;text-wrap:balance;overflow-wrap:anywhere}h2{font-size:22px;line-height:1.5;letter-spacing:-.015em}h3{font-size:17px;line-height:1.6}p,li{line-height:1.9}p{margin-bottom:18px}.muted,.caption{color:var(--muted)}.caption{font-size:13px;line-height:1.8}.breadcrumbs{font-size:13px;color:var(--muted);display:flex;gap:12px;flex-wrap:wrap;margin-bottom:28px}.breadcrumbs a{color:inherit}.article-layout{display:grid;grid-template-columns:minmax(0,740px) minmax(250px,292px);gap:64px;align-items:start}.article{min-width:0}.article h1{margin-bottom:20px}.article-meta{font-size:12px;color:var(--muted);display:flex;gap:16px;flex-wrap:wrap;margin-bottom:28px;line-height:1.7}.article-meta time{font-variant-numeric:tabular-nums}.lead{font-size:17px;line-height:1.95;color:#35465e}.highlights{padding:20px 0 20px 24px;margin:24px 0 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);font-size:15px}.highlights li+li{margin-top:8px}.article-section{margin-top:40px}.article-section>h2{margin-bottom:16px}.article-section p,.article-section li{font-size:15px}.article-section ul,.article-section ol{padding-left:24px}.section-note{margin-top:16px;color:var(--muted);font-size:12px!important}.section-note a{margin-right:10px}.section-kind{font-size:12px;font-weight:400;color:var(--muted);margin-left:12px}.file-list{padding:0;margin:0;list-style:none}.file-list li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:16px;padding:12px 0;border-bottom:1px solid var(--line);font-size:14px}.file-list .file-name{overflow-wrap:anywhere}.file-list .file-type{font-size:12px;color:var(--muted);margin-top:2px}.file-list .file-size{color:var(--muted);font-size:12px;white-space:nowrap;font-variant-numeric:tabular-nums}.facts-note{margin-top:14px;font-size:13px!important;color:var(--muted)}
.get-panel{position:sticky;top:24px;border:1px solid var(--line);border-radius:12px;padding:24px;background:#fff}.get-panel h2{font-size:18px;margin-bottom:8px}.get-panel .provider{font-size:13px;color:var(--muted);margin-bottom:24px}.get-panel .button{width:100%}.button{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:42px;padding:10px 16px;border:1px solid #a6b4c8;border-radius:7px;background:#fff;color:#1d2b42;text-decoration:none;font-size:14px;line-height:1.5;cursor:pointer}.button.primary{background:var(--blue);border-color:var(--blue);color:#fff;font-weight:600}.button.primary:hover{background:#244eaf;text-decoration:none}.button:hover{background:var(--wash);text-decoration:none}.get-panel .button+.button{margin-top:10px}.share-detail{margin-top:22px;border-top:1px solid var(--line);padding-top:18px}.share-detail summary{font-size:13px;cursor:pointer;color:var(--muted)}.share-url{font-size:12px;overflow-wrap:anywhere;margin:12px 0;user-select:all}.share-code{display:flex;align-items:center;gap:12px;font-size:13px;margin:18px 0}.share-code strong{font-size:18px;letter-spacing:.1em;user-select:all}.copy-status{font-size:12px;min-height:20px;margin:10px 0;color:var(--muted)}.copy-status[data-kind="success"]{color:#237a5e}.copy-status[data-kind="error"]{color:#b23c48}.get-panel .caption{margin:16px 0 0}.toc{margin-top:24px;padding-top:20px;border-top:1px solid var(--line)}.toc p{font-size:12px;color:var(--muted);margin-bottom:10px}.toc a{display:block;font-size:13px;color:#35465e;text-decoration:none;padding:7px 0;line-height:1.65}.toc a:hover{color:var(--blue)}
.faq details{padding:18px 0;border-bottom:1px solid var(--line)}.faq summary{cursor:pointer;font-size:15px;font-weight:600;line-height:1.7}.faq details p{margin:14px 0 0}.sources{margin-top:40px;padding:22px 0;border-top:1px solid var(--line);color:var(--muted);font-size:13px}.sources summary{font-weight:600;cursor:pointer}.sources p{font-size:13px!important}.source-entry{padding-top:18px}.source-entry h3{font-size:13px;margin-bottom:6px}.related{margin-top:40px;border-top:1px solid var(--line);padding-top:28px}.related h2{font-size:20px}.related a{display:block;padding:12px 0;border-bottom:1px solid var(--line);font-size:14px;line-height:1.7}
.directory-heading{max-width:760px;margin:16px 0 28px}.directory-heading h1{font-size:36px;margin-bottom:14px}.directory-heading p{font-size:16px;color:var(--muted);line-height:1.9}.search-form{display:flex;gap:10px;max-width:600px;margin:28px 0 18px}.search-form input{flex:1;min-width:0;min-height:42px;border:1px solid #91a0b5;border-radius:7px;padding:9px 12px;background:#fff}.category-links{display:flex;flex-wrap:wrap;gap:12px 24px;font-size:13px;padding:16px 0 24px;border-bottom:1px solid var(--line)}.category-links a{color:var(--muted);text-decoration:none}.category-links a[aria-current]{color:var(--blue);font-weight:650}.directory-list{display:grid;grid-template-columns:1fr 1fr;gap:0 48px}.directory-entry{padding:28px 0;border-bottom:1px solid var(--line)}.directory-entry h2{font-size:21px;line-height:1.5;margin-bottom:12px}.directory-entry h2 a{color:#1d2b42;text-decoration:none}.directory-entry h2 a:hover{color:var(--blue)}.directory-entry p{font-size:14px;color:var(--muted);line-height:1.8;margin-bottom:14px}.entry-meta{font-size:12px;color:var(--muted);display:flex;gap:16px;flex-wrap:wrap}.pagination{display:flex;justify-content:space-between;gap:16px;margin-top:28px;font-size:14px}.empty-message{padding:48px 0;max-width:600px}.text-page{max-width:740px}.text-page>h1{margin-bottom:28px}.text-page h2{margin-top:40px}.text-page p{font-size:15px}.skip{position:absolute;left:-9999px}.skip:focus{left:24px;top:12px;background:#fff;z-index:10;padding:12px}
@media(max-width:980px){.article-layout{gap:32px;grid-template-columns:minmax(0,1fr) 260px}.site-main{padding-top:24px}h1{font-size:30px}}@media(max-width:760px){.site-header,.site-footer,.site-main{width:calc(100% - 40px)}.site-header{padding:18px 0}.brand span{display:none}.article-layout{display:flex;flex-direction:column;gap:32px}.get-panel{position:static;width:100%;order:2}.article{width:100%}.directory-list{grid-template-columns:1fr}.site-nav{gap:18px}h1,.directory-heading h1{font-size:28px}.site-main{padding-bottom:40px}.article-section{margin-top:32px}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
`;
export const copyScript = `for(const b of document.querySelectorAll('[data-copy]')){b.addEventListener('click',async()=>{const s=document.getElementById('copy-status'),link=document.getElementById('share-link')?.textContent||'',code=document.getElementById('share-code')?.textContent||'';b.disabled=true;try{await navigator.clipboard.writeText(b.dataset.copy==='code'?code:link+(code?'\\n提取码：'+code:''));s.textContent='已复制。';s.dataset.kind='success';}catch{s.textContent='复制未完成，请选中链接手动复制。';s.dataset.kind='error';}finally{b.disabled=false;}});}for(const a of document.querySelectorAll('a[href^="#evidence-"]')){a.addEventListener('click',()=>{let p=document.getElementById(a.getAttribute('href').slice(1))?.parentElement;while(p){if(p.tagName==='DETAILS')p.open=true;p=p.parentElement;}});}`;
export function siteDocument(input: {
  nonce: string;
  title: string;
  description: string;
  canonical: string;
  indexable: boolean;
  body: string;
  structured?: unknown;
  script?: boolean;
}) {
  const e = escapeHtml;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${e(input.title)} · 盘序资源</title><meta name="description" content="${e(input.description)}"><meta name="robots" content="${input.indexable ? "index,follow,max-snippet:-1,max-image-preview:large" : "noindex,follow"}"><link rel="canonical" href="${e(input.canonical)}"><meta property="og:locale" content="zh_CN"><meta property="og:type" content="${input.structured ? "article" : "website"}"><meta property="og:title" content="${e(input.title)}"><meta property="og:description" content="${e(input.description)}"><meta property="og:url" content="${e(input.canonical)}"><meta property="og:site_name" content="盘序资源"><meta name="twitter:card" content="summary"><style nonce="${input.nonce}">${siteStyle}</style>${input.structured ? `<script type="application/ld+json" nonce="${input.nonce}">${jsonLd(input.structured)}</script>` : ""}</head><body><a class="skip" href="#main-content">跳到主要内容</a><header class="site-header"><a class="brand" href="/">盘序<span>资源索引</span></a><nav class="site-nav" aria-label="网站导航"><a href="/">资源目录</a><a href="/about">整理方式</a></nav></header><main class="site-main" id="main-content">${input.body}</main><footer class="site-footer"><p>资源说明与使用建议由盘序整理，部分内容使用 AI 辅助。<br>文件由分享者在网盘提供，介绍与文件内容范围请以页面依据为准。</p><p><a href="/about">关于与整理方式</a> · <a href="/sitemap.xml">站点地图</a></p></footer>${input.script ? `<script nonce="${input.nonce}">${copyScript}</script>` : ""}</body></html>`;
}
export function paragraphs(text: string) {
  return text
    .split(/\n\s*\n/)
    .filter(Boolean)
    .map((part) => {
      const lines = part.trim().split("\n");
      if (lines.every((l) => /^\s*(?:[-*•]|\d+[.、)])\s*/.test(l)))
        return `<ul>${lines.map((l) => `<li>${escapeHtml(l.replace(/^\s*(?:[-*•]|\d+[.、)])\s*/, ""))}</li>`).join("")}</ul>`;
      return `<p>${escapeHtml(part).replace(/\n/g, "<br>")}</p>`;
    })
    .join("");
}
