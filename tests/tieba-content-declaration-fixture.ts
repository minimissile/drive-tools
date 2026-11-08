export type DeclarationFixtureMode =
  | "absent"
  | "selectable"
  | "unconfirmed"
  | "ambiguous"
  | "original-only"
  | "disabled";
export function contentDeclarationFixture(
  mode: DeclarationFixtureMode = "selectable",
) {
  if (mode === "absent") return "";
  const ai = `<div class="select-box-item" ${mode === "disabled" ? 'aria-disabled="true"' : ""}>贴子含AI内容</div>`;
  return `<div class="ai-entrance"><span class="ai-entrance-text">内容声明</span></div>
    <div id="ai-entrance-select-box" style="display:none">${mode === "original-only" ? "" : ai}${mode === "ambiguous" ? ai : ""}<div class="select-box-item">贴子原创声明</div></div>
    <script>window.__declarationClicks=[];document.querySelector('.ai-entrance').addEventListener('click',()=>{window.__declarationClicks.push('入口');document.querySelector('#ai-entrance-select-box').style.display='block';});
    for(const item of document.querySelectorAll('#ai-entrance-select-box .select-box-item'))item.addEventListener('click',()=>{window.__declarationClicks.push(item.innerText);${mode === "unconfirmed" ? "" : "document.querySelector('.ai-entrance-text').innerText=item.innerText;for(const other of document.querySelectorAll('#ai-entrance-select-box .select-box-item'))other.setAttribute('aria-selected',String(other===item));document.querySelector('#ai-entrance-select-box').style.display='none';"}});</script>`;
}
