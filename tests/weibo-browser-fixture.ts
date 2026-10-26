/** Local official-page simulation. No remote post can be created by this fixture. */
export const weiboBrowserFixture = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body>
<div data-v-app><textarea placeholder="有什么新鲜事想分享给大家？" style="width:600px;height:120px"></textarea><button>发送</button></div>
<script>
window.$CONFIG = { uid: '1234567890', nick: '模拟指纹微博' };
const root = document.querySelector('[data-v-app]'), textarea = document.querySelector('textarea');
const visible = { visible: 0, visibleChange(_event, value) { this.visible = value; publisher.visible = value; } };
const publisher = { content: '', pic_id: [], visible: 0, toolAction: '', media: {}, vote: {}, pri: 0, formCount: {count: 12, maxcount: 2000}, $el: root, $refs: {image:{uploading:false,upload_list:[]}, tools:{$refs:{visible}}}, $nextTick: async()=>{}, toolbarPublish:()=>{}, pasteImg:()=>publisher.pic_id.push({pid:'fixture-picture',status:3}) };
root._vnode = {component:{subTree:{children:[{component:{proxy:publisher}}]}}};
textarea.oninput = () => publisher.content = textarea.value;
document.querySelector('button').onclick = async()=>{
 await fetch('/ajax/statuses/update', {method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:new URLSearchParams({content:publisher.content, visible:String(publisher.visible)})});
 publisher.content=''; textarea.value=''; publisher.pic_id=[];
};
</script></body></html>`;
