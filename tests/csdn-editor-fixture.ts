/** Offline UI contract fixture, reflecting the official Markdown editor's observed selectors.
 * No official page or account is contacted. Requests must be intercepted by the test.
 */
export const csdnEditorFixture = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>CSDN 本机模拟编辑器</title><style>input[type="radio"]{display:none}.gitcode-box input{position:absolute;left:-9999px;opacity:0}</style></head><body>
<div id="app">
  <div class="article-bar__title-display">请输入文章标题（5~100个字）</div>
  <input class="article-bar__title" style="display:none" maxlength="100">
  <pre class="editor__inner" contenteditable="true"></pre>
  <button class="btn-publish">发布文章</button>
  <div class="modal__publish-article" style="display:none">
    <div class="form-entry"><label class="form-entry__label">文章标签</label><div class="selected-tags"></div><button class="tag__btn-tag">添加文章标签</button><div class="mark_selection_box" style="display:none"><input placeholder="请输入文字搜索，Enter键入可添加自定义标签"><ul class="el-autocomplete-suggestion"></ul></div></div>
    <div class="form-entry"><label class="form-entry__label">文章摘要</label><textarea></textarea></div>
    <input type="radio" id="original" name="articleType" value="original"><label for="original">原创</label>
    <input type="radio" id="public" name="readType" value="public"><label for="public">全部可见</label>
    <div class="creation-statement-select"><input readonly value="无声明"></div><div class="el-select-dropdown" style="display:none"><div class="el-select-dropdown__item">无声明</div><div class="el-select-dropdown__item">部分内容由AI辅助生成</div></div>
    <div class="gitcode-box"><label><input type="checkbox" checked>同时备份到GitCode</label></div>
    <button class="final-publish">发布文章</button>
  </div>
</div>
<script>
const find=(selector)=>document.querySelector(selector);
find('.article-bar__title-display').onclick=()=>{find('.article-bar__title').style.display='block';find('.article-bar__title-display').style.display='none';};
find('.article-bar__title').onkeydown=(event)=>{if(event.key==='Enter'){event.target.style.display='none';find('.article-bar__title-display').style.display='block';find('.article-bar__title-display').textContent=event.target.value;}};
find('.btn-publish').onclick=()=>find('.modal__publish-article').style.display='block';
find('.tag__btn-tag').onclick=()=>find('.mark_selection_box').style.display='block';
find('.mark_selection_box input').oninput=(event)=>{
  const list=find('.el-autocomplete-suggestion');list.innerHTML='';
  if(!['Python','Matplotlib'].includes(event.target.value))return;
  const item=document.createElement('li');item.textContent=event.target.value;
  item.onclick=()=>{const box=document.createElement('div');const name=document.createElement('span');name.className='tag__name';name.textContent=item.textContent;const remove=document.createElement('button');remove.className='tag__btn-tag-delete';remove.textContent='删除';remove.onclick=()=>box.remove();box.append(name,remove);find('.selected-tags').append(box);find('.mark_selection_box').style.display='none';};list.append(item);
};
find('.creation-statement-select').onclick=()=>find('.el-select-dropdown').style.display='block';
document.querySelectorAll('.el-select-dropdown__item').forEach(item=>item.onclick=()=>{find('.creation-statement-select input').value=item.textContent;find('.el-select-dropdown').style.display='none';});
find('.final-publish').onclick=async()=>{
 const response=await fetch('https://bizapi.csdn.net/blog-console-api/v3/mdeditor/saveArticle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pubStatus:'publish',title:find('.article-bar__title').value,markdowncontent:find('.editor__inner').innerText,tags:[...document.querySelectorAll('.tag__name')].map(tag=>tag.textContent).join(','),readType:'public'})});
 window.lastReceipt=await response.json();
};
</script></body></html>`;
