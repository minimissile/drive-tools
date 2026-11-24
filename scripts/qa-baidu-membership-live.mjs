import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";

/** Real membership/cache readback in a dedicated workbench; no remote mutations. */
export async function run({page,windowId,checkpoint}) {
  const minimum=Number(process.env.PANXU_MEMBERSHIP_MIN_REVISION||52);
  const initial=await page.evaluate(async()=>({updates:await window.panxu.invoke("dev.updates"),accounts:(await window.panxu.invoke("snapshot")).accounts.filter(a=>a.provider==="baidu"&&a.enabled),environments:await window.panxu.invoke("environments.list")}));
  assert.ok(initial.updates.runningRevision>=minimum,"会员修复后端尚未加载");
  const results=[];
  for(const account of initial.accounts){
    await checkpoint();
    const busy=account.browser&&initial.environments.find(e=>e.id===account.browser.environmentId)?.busy;
    let value=account,reason="";
    if(account.status!=="connected")reason="原登录未恢复，按此前约定跳过";
    else if(busy)reason="保留现有环境操作，暂不刷新";
    else {
      try{value=await page.evaluate(id=>window.panxu.invoke("account.capacity",{id}),account.id);}
      catch(error){reason=error.message;}
    }
    if(value.membership?.value)assert.equal(value.membership.parserRevision,2,"旧版识别结果不应继续展示");
    const expiry=value.membership?.value?.expiresAt;
    if(expiry)assert.ok(![2147483647,2147483648,4294967295].includes(Date.parse(expiry)/1000));
    results.push({alias:value.alias,status:value.status,membership:value.membership?.value,parserRevision:value.membership?.parserRevision,error:value.membership?.error,reason});
  }
  await page.setViewportSize({width:1366,height:768});
  await page.getByRole("tab",{name:new RegExp(`^百度\\s+${initial.accounts.length}$`)}).click();
  await page.getByRole("region",{name:"账号批量操作",exact:true}).getByRole("button",{name:/批量操作.*展开/}).waitFor();
  const out=`/private/tmp/panxu-baidu-membership/${windowId}`;await mkdir(out,{recursive:true});
  await page.screenshot({path:out+"/accounts.png",fullPage:true});
  await writeFile(out+"/results.json",JSON.stringify({revision:initial.updates.runningRevision,results},null,2));
  console.log(JSON.stringify({out,revision:initial.updates.runningRevision,results},null,2));
}
