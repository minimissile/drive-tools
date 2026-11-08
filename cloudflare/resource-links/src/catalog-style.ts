/** Public catalog layout; shared site typography and controls remain in site-shell. */
export const catalogStyle = `
.catalog-heading{max-width:900px;margin:0 0 32px}
.catalog-heading h1{font-size:32px;line-height:1.45;letter-spacing:-.025em;margin:0 0 12px}
.catalog-heading .lead{font-size:15px;line-height:1.85;max-width:76ch}
.catalog-heading .lead p{margin-bottom:0}
.catalog-meta{display:flex;align-items:center;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--muted);margin-top:16px;font-variant-numeric:tabular-nums}
.catalog-layout{display:grid;grid-template-columns:168px minmax(0,1fr);gap:40px;align-items:start}
.catalog-filter{position:sticky;top:24px;padding-top:8px}
.catalog-filter h2{font-size:13px;font-weight:650;margin:0 0 14px 12px}
.catalog-filter nav{display:grid;gap:4px}
.catalog-filter a{display:flex;align-items:baseline;justify-content:space-between;gap:12px;min-height:38px;padding:9px 12px;border-radius:7px;font-size:13px;line-height:1.5;color:var(--muted);text-decoration:none;overflow-wrap:anywhere;transition:background-color 160ms ease,color 160ms ease}
.catalog-filter a span{min-width:0}
.catalog-filter a small{flex:none;font-size:11px;font-variant-numeric:tabular-nums}
.catalog-filter a[aria-current]{color:var(--blue);background:var(--wash);font-weight:650}
.catalog-filter a:hover{color:var(--blue);background:var(--wash);text-decoration:none}
.catalog-resources{min-width:0}
.catalog-toolbar{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;padding-bottom:20px}
.catalog-toolbar .search-form{flex:1;max-width:550px;margin:0;gap:8px}
.catalog-toolbar .search-form input{font-size:13px;background:var(--wash);border-color:var(--line)}
.catalog-toolbar .search-form input::placeholder{color:var(--muted);opacity:1}
.catalog-toolbar p{margin:0;color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}
.catalog-filter-reset{font-size:12px;white-space:nowrap}
.catalog-list-heading{display:grid;grid-template-columns:minmax(0,1fr) 160px;gap:24px;padding:11px 16px;background:var(--wash);border-block:1px solid var(--line);font-size:12px;font-weight:500;color:var(--muted)}
.catalog-list-heading span:last-child{text-align:right}
.catalog-resource{display:grid;grid-template-columns:minmax(0,1fr) 160px;gap:12px 24px;align-items:start;padding:18px 16px;border-bottom:1px solid var(--line);scroll-margin-top:24px;transition:background-color 160ms ease}
.catalog-resource:hover{background:#fafbfe}
.catalog-resource-content{min-width:0}
.catalog-resource h2{font-size:16px;line-height:1.65;letter-spacing:0;font-weight:650;margin:0 0 6px;overflow-wrap:anywhere}
.catalog-resource h2 a{color:inherit;text-decoration:none}
.catalog-resource h2 a:hover{color:var(--blue);text-decoration:underline}
.catalog-resource-meta{display:flex;align-items:center;flex-wrap:wrap;gap:6px 12px;font-size:12px;color:var(--muted);line-height:1.7}
.catalog-resource-meta a{text-decoration:none}
.catalog-resource-meta a:hover{text-decoration:underline}
.catalog-resource-summary{margin-top:10px;max-width:75ch;color:#35465e;overflow-wrap:anywhere}
.catalog-resource-summary p,.catalog-resource-summary li{font-size:13px;line-height:1.85}
.catalog-resource-summary p:last-child,.catalog-resource-summary ul:last-child{margin-bottom:0}
.catalog-tags{display:flex;gap:6px;flex-wrap:wrap;font-size:11px;color:var(--muted);margin-top:10px}
.catalog-tags span{background:var(--wash);padding:2px 7px;border-radius:4px;overflow-wrap:anywhere}
.catalog-actions{display:grid;justify-items:end;gap:8px;padding-top:1px;min-width:0}
.catalog-share{display:grid;gap:5px;justify-items:end;min-width:0}
.catalog-open-link{min-height:36px;padding:7px 11px;font-size:12px;border-color:var(--line);gap:7px;white-space:nowrap;transition:background-color 160ms ease,border-color 160ms ease}
.catalog-open-link:hover{color:var(--blue);border-color:#adbfdf}
.catalog-open-link svg{width:14px;height:14px;flex:none}
.catalog-share span{font-size:11px;color:var(--muted)}
.catalog-share code{font-family:inherit;font-variant-numeric:tabular-nums;letter-spacing:.04em;color:#1d2b42;user-select:all}
.catalog-more-shares{grid-column:1/-1;min-width:0}
.catalog-more-shares summary{width:fit-content;font-size:12px;line-height:1.8;color:var(--blue);cursor:pointer;list-style-position:inside}
.catalog-more-shares[open] summary{margin-bottom:12px}
.catalog-share-list{margin:0;padding:0;list-style:none;display:grid;gap:8px 24px;grid-template-columns:repeat(2,minmax(0,1fr))}
.catalog-share-list li{display:flex;align-items:baseline;gap:6px 12px;flex-wrap:wrap;min-width:0;font-size:12px;line-height:1.75}
.catalog-share-list a{overflow-wrap:anywhere;text-decoration:none}
.catalog-share-list a:hover{text-decoration:underline}
.catalog-share-list span{font-size:11px;color:var(--muted);white-space:nowrap}
.catalog-share-list code{font-family:inherit;font-variant-numeric:tabular-nums;color:#1d2b42;user-select:all}
.catalog-note{font-size:12px!important;color:var(--muted);line-height:1.85;margin:24px 16px 0;max-width:75ch}
.catalog-resources>.pagination{align-items:center;font-size:12px;margin-top:20px}
.catalog-page-count{color:var(--muted);font-variant-numeric:tabular-nums}
.catalog-index-meta{display:flex;justify-content:space-between;gap:20px;color:var(--muted);font-size:13px}
.catalog-home-section{margin-top:36px;border-top:1px solid var(--line);padding-top:24px}
.catalog-home-heading{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:12px}
.catalog-home-heading h2{margin:0;font-size:20px}
.catalog-home-heading>a{font-size:13px}
.catalog-home-list{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:24px}
.catalog-home-list a{color:#1d2b42;font-size:15px;line-height:1.7;overflow-wrap:anywhere}
.catalog-home-list span{display:block;font-size:12px;color:var(--muted);margin-top:6px}
@media(max-width:980px){.catalog-layout{grid-template-columns:144px minmax(0,1fr);gap:24px}.catalog-resource,.catalog-list-heading{grid-template-columns:minmax(0,1fr) 136px;gap:12px 20px}.catalog-resource{padding-inline:12px}}
@media(max-width:760px){.catalog-heading h1{font-size:26px}.catalog-layout{grid-template-columns:1fr;gap:20px}.catalog-filter{position:static;padding:0}.catalog-filter h2{margin-left:0;margin-bottom:10px}.catalog-filter nav{display:flex;flex-wrap:wrap;gap:6px}.catalog-filter a{gap:10px}.catalog-toolbar{gap:12px}.catalog-toolbar .search-form{flex-basis:100%;max-width:none}.catalog-list-heading{display:none}.catalog-resource{grid-template-columns:minmax(0,1fr);padding:18px 0;gap:10px}.catalog-actions{justify-items:start}.catalog-share{display:flex;align-items:center;justify-items:start;gap:12px;flex-wrap:wrap}.catalog-more-shares{grid-column:1}.catalog-share-list{grid-template-columns:1fr}.catalog-note{margin-inline:0}.catalog-home-list{grid-template-columns:1fr}}
@media(prefers-reduced-motion:reduce){.catalog-filter a,.catalog-resource,.catalog-open-link{transition:none}}
`;
