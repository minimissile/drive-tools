/** Representative editor contract; all mutations are intercepted by local routes. */
export const zhihuBrowserFixture = (
  kind: "article" | "answer",
  ai = true,
  dialog = false,
) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body>
${kind === "article" ? '<textarea placeholder="请输入标题"></textarea>' : '<button id="write">写回答</button>'}
<div class="DraftEditor-root"><div class="public-DraftEditor-content" contenteditable="true" style="min-height:200px"></div></div>
<input type="file" accept="image/*" multiple />
${ai ? '<label><input type="checkbox">包含AI辅助创作</label>' : ""}
<button id="publish">${kind === "article" ? (dialog ? "发布" : "发布文章") : "发布回答"}</button>
<script>
document.querySelector('input[type=file]').onchange = () => {
 for (const f of document.querySelector('input[type=file]').files) {const image = document.createElement('img'); image.src='https://pic1.zhimg.com/fixture.png';document.querySelector('[contenteditable]').append(image);}
};
const commit=()=>fetch(${JSON.stringify(kind === "article" ? "/api/articles/123/publish" : "/api/v4/questions/123/answers")}, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content:document.querySelector('[contenteditable]').innerText})});
document.getElementById('publish').onclick=${dialog ? `()=>{const dialog=document.createElement('dialog');dialog.open=true;const button=document.createElement('button');button.textContent='发布文章';button.onclick=commit;dialog.append(button);document.body.append(dialog);}` : "commit"};
</script></body></html>`;
