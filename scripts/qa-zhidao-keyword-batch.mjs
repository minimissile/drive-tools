import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

export async function run({page,windowId}) {
  const out="/tmp/panxu-keyword-batch";await mkdir(out,{recursive:true});
  const errors=[];page.on("pageerror",error=>errors.push(error.message));
  await page.setViewportSize({width:1440,height:900});
  await page.route("**/src/api/client.ts*",async route=>{
    const response=await route.fetch(),body=await response.text();
    await route.fulfill({response,body:'import { publishingMock } from "/scripts/qa-zhidao-publishing-mock.mjs";\n'+body.replace(/return window\.panxu\.invoke[^;]+;/,"return publishingMock(method,args);"),contentType:"application/javascript"});
  });
  const click=locator=>locator.evaluate(node=>{node.focus();node.click();});
  try {
    await page.reload();
    await page.getByRole("heading",{name:"问答发布",exact:true}).waitFor();
    await page.getByRole("combobox",{name:"搜索资源库",exact:true}).fill("办公");
    await click(page.getByRole("option",{name:"办公表格练习 · 效率办公",exact:true}));
    await click(page.getByRole("button",{name:"录入库外资源",exact:true}));
    await page.getByLabel("第2行名称",{exact:true}).evaluate(node=>{
      const data=new DataTransfer();data.setData("text/plain","预算整理\thttps://pan.baidu.com/s/budget\t效率办公\t预算核对清单\n课程练习\thttps://pan.baidu.com/s/study\t学习资料\t课程练习与复盘资料");
      node.dispatchEvent(new ClipboardEvent("paste",{clipboardData:data,bubbles:true,cancelable:true}));
    });
    await click(page.getByRole("button",{name:"下一步：检查关键词",exact:true}));
    await click(page.getByRole("button",{name:"批量检索待查资源（2）",exact:true}));
    await click(page.getByRole("button",{name:/2\. 预算整理/}));
    const words=page.getByLabel("候选关键词",{exact:true});
    await page.waitForFunction(()=>document.querySelector('[aria-label="候选关键词"]')?.value.includes("预算整理流量词"));
    assert.equal(await page.getByRole("button",{name:"检索流量词",exact:true}).isDisabled(),true);
    await words.fill("预算整理流量词\n我保留的预算词");
    await page.screenshot({path:`${out}/batch-running.png`});
    await page.reload();
    await page.getByText(/检索中，可以先检查/).waitFor();
    assert.match(await page.getByLabel("候选关键词",{exact:true}).inputValue(),/我保留的预算词/);
    await page.evaluate(()=>{window.__keywordBatchFinish=true;});
    await page.getByText("已完成2份检索，请逐份检查候选词。",{exact:true}).waitFor();
    assert.match(await page.getByLabel("候选关键词",{exact:true}).inputValue(),/我保留的预算词/);
    await click(page.getByRole("button",{name:/3\. 课程练习/}));
    assert.equal(await page.getByLabel("候选关键词",{exact:true}).inputValue(),"课程练习流量词");
    await click(page.getByRole("button",{name:/1\. 办公表格练习/}));
    await page.getByText(/已跳过重复检查/).waitFor();
    const calls=await page.evaluate(()=>JSON.parse(sessionStorage.getItem("zhidao-publishing-qa")).calls);
    assert.equal(calls.filter(call=>call.method==="resource.keywordBatch").length,1);
    assert.equal(calls.find(call=>call.method==="resource.keywordBatch").args.items.length,2);
    await page.screenshot({path:`${out}/batch-complete.png`});
    assert.deepEqual(errors,[]);
    return {windowId,checks:["一次提交两份待查资源","库中已存词跳过","部分返回即可筛选","刷新保留批次与人工修改","结果按资源隔离"]};
  } catch(error){await page.screenshot({path:`${out}/failure.png`});throw error;}
}
