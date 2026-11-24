import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
async function editMock(method,args) {
  const state=(window.__driveEditQa??={base:null,calls:[],title:"本人目录资料"});
  const time="2026-11-24T08:00:00.000Z",source="https://pan.quark.cn/#panxu-owned=local-file";
  const copy={id:"indexed-copy",resourceId:"indexed-resource",accountId:"indexed-account",directory:"/资料",folderId:null,files:[{id:"file",name:"练习资料.pdf",isDirectory:false,size:100,parentId:"folder",path:"/资料/练习资料.pdf"}],selectedFiles:[],status:"recorded",ownerUid:"owner",verifiedAt:time,shareId:null,shareUrl:null,shareOwnerUid:null,shareVersion:0,shareVerifiedAt:null,noteStatus:"not_configured",error:null,createdAt:time,updatedAt:time};
  const resource={id:"indexed-resource",title:state.title,sourceKind:"owned",sourceUrl:source,provider:"quark",category:"未分类",tags:[],searchKeywords:[],summary:"本人资料整理",coverId:null,revision:1,createdAt:time,updatedAt:time,copies:[copy]};
  if(method==="snapshot") {
    const base=(state.base??=await window.panxu.invoke(method,args));
    return {...base,dataPath:base.dataPath+"/drive-sync-edit-qa",resources:[resource],resourceTotals:{resources:1,readyCopies:0,attentionJobs:0,categories:["未分类"]},accounts:[{id:"indexed-account",alias:"本人夸克账号",provider:"quark",uid:"owner",enabled:true,status:"connected",isDefault:true,browserEngine:"electron",defaultDirectory:"/",error:null}],shareChecks:[]};
  }
  if(method==="resource.get")return resource;
  if(method==="resource.page")return {items:[resource],total:1,page:1,pageSize:25};
  if(method==="resource.similar")return [];
  if(method==="resource.intakeOptions")return {categories:["未分类","效率办公"],directories:["/资料"]};
  if(method==="resource.save"){state.calls.push({method,args});state.title=args.title;return {resourceId:resource.id,copyId:copy.id,jobId:null};}
  if(method==="share.parse"||method==="share.validate"){state.calls.push({method,args});throw Error("目录登记不应解析为分享");}
  return window.panxu.invoke(method,args);
}
export async function run({page,windowId}) {
  const out=`/private/tmp/panxu-drive-sync-edit/${windowId}`;await mkdir(out,{recursive:true});
  const errors=[];page.on("pageerror",e=>errors.push(e.message));
  await page.setViewportSize({width:1440,height:900});
  await page.route("**/src/api/client.ts*",async route=>{
    const response=await route.fetch({maxRetries:2}),body=await response.text(),next=body.replace(/return window\.panxu\.invoke[^;]+;/,"return editMock(method,args);");
    assert.notEqual(body,next);await route.fulfill({response,body:editMock.toString()+"\n"+next,contentType:"application/javascript"});
  });
  try {
  await page.reload();
  await page.locator('[aria-label="资源库概况与操作"]').waitFor();
  await page.getByText("本人目录资料",{exact:true}).first().click();
  await page.getByRole("button",{name:"更多资源操作",exact:true}).click();
  await page.getByRole("menuitem",{name:"编辑资料",exact:true}).click();
  await page.getByRole("heading",{name:"继续整理这份资源。",exact:true}).waitFor();
  assert.equal(await page.getByRole("textbox",{name:"本人网盘文件来源",exact:true}).inputValue(),"/资料/练习资料.pdf");
  await page.getByRole("textbox",{name:"资源标题",exact:true}).fill("资料内容整理完成");
  await page.getByRole("button",{name:"下一步：检索流量词",exact:true}).click();
  await page.getByRole("button",{name:"保存资料",exact:true}).waitFor();
  await page.screenshot({path:out+"/metadata.png",fullPage:false});
  await page.getByRole("button",{name:"保存资料",exact:true}).click();
  await page.locator('[aria-label="资源库概况与操作"]').waitFor();
  const calls=await page.evaluate(()=>window.__driveEditQa.calls);
  assert.ok(calls.some(c=>c.method==="resource.save"&&c.args.isOwnResource&&c.args.title==="资料内容整理完成"));
  assert.ok(calls.every(c=>!c.method.startsWith("share.")));
  assert.deepEqual(errors,[]);console.log(JSON.stringify({windowId,out,verified:"indexed own resource metadata edit without share parsing or transfer"}));
  } catch (error) {
    await page.screenshot({path:out+"/failure.png",fullPage:false}).catch(()=>{});
    console.log((await page.locator("body").innerText()).slice(0,3000));
    throw error;
  }
}
