import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

// Browser plugin not available; task-owned Electron renderer. No saved resources or remote writes.
export async function run({ page, windowId }) {
  console.log(JSON.stringify({ windowId, phase: "started" }));
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  page.setDefaultTimeout(15000);
  await page.route("**/src/api/client.ts*", async (route) => {
    const response = await route.fetch(),
      source = await response.text();
    const stub = source.replace(
      "return window.panxu.invoke(method, args);",
      `return (async () => {
   if(method==="snapshot") return window.panxu.invoke(method,args).then(s=>({...s,resources:[],accounts:[{id:"reset-fixture",alias:"重置验收账号",provider:"quark",enabled:true,status:"connected",uid:"reset-owner",isDefault:true,defaultDirectory:"/盘序资源"}]}));
   if(method==="resource.intakeOptions") return {categories:["效率办公","学习资料"],directories:["/盘序资源"]};
   if(method==="resource.similar") return args.title==="已有的同名资料"?[{id:"existing-fixture",title:args.title,provider:"quark",similarity:1}]:[];
   if(method==="share.validate") return {status:"valid",message:"链接有效",checkedAt:new Date().toISOString()};
   if(method==="websiteAccounts.list") return [];
   if(method==="resource.keywordLookup") return new Promise(resolve=>{window.__releaseOldLookup=()=>resolve({candidates:[{word:"不应回填的旧关键词",sources:["suggest"],seeds:args.seeds}],issues:[]});});
   if(method==="resource.save" || method==="share.inspect") throw Error("重置验收不得保存资源或转存");
   return window.panxu.invoke(method,args); })();`,
    );
    assert.notEqual(stub, source);
    await route.fulfill({
      response,
      body: stub,
      contentType: "application/javascript",
    });
  });
  await page.reload();
  const source = page.getByLabel("网盘分享链接", { exact: true });
  const title = page.getByLabel("资源标题", { exact: true });
  const footer = page.getByRole("group", { name: "资源保存操作" });
  const reset = footer.getByRole("button", { name: "重置", exact: true });
  const next = footer.getByRole("button", {
    name: "下一步：检索流量词",
    exact: true,
  });
  const fill = async (name) => {
    await source.fill("https://pan.quark.cn/s/resetfixture");
    await title.fill(name);
  };
  const emptyInfo = async () => {
    assert.equal(await source.inputValue(), "");
    assert.equal(await title.inputValue(), "");
    assert.equal(
      await page.getByLabel("提取码", { exact: true }).inputValue(),
      "",
    );
    assert.equal(
      await page.getByLabel("资源标签", { exact: true }).inputValue(),
      "",
    );
    assert.equal(await page.getByLabel("资源说明").inputValue(), "");
    assert.equal(
      await page.getByRole("img", { name: "待保存封面" }).count(),
      0,
    );
    assert.equal(await page.getByText(/已恢复未保存的输入/).count(), 0);
    assert(await next.isDisabled());
  };
  await fill("已有的同名资料");
  await page
    .getByText("同名资源已在此类网盘入库，请查看并编辑已有记录。", {
      exact: true,
    })
    .waitFor();
  assert(await next.isDisabled());
  assert(await reset.isEnabled());
  const [r, n] = await Promise.all([reset.boundingBox(), next.boundingBox()]);
  assert(
    r && n && r.x + r.width <= n.x && Math.abs(r.y - n.y) < 2,
    "重置紧邻下一步左侧并对齐",
  );
  await reset.click();
  await emptyInfo();
  await fill("办公练习资料");
  await page.getByLabel("提取码", { exact: true }).fill("8002");
  await page.getByLabel("资源标签", { exact: true }).fill("办公，练习");
  await page.getByLabel("资源说明").fill("需要重置的说明");
  await page.locator("input[type=file]").setInputFiles({
    name: "cover.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRkwAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await page.getByRole("img", { name: "待保存封面" }).waitFor();
  await next.click();
  const seeds = page.getByRole("textbox", { name: "搜索词", exact: true });
  const candidates = page.getByRole("textbox", {
    name: "候选关键词",
    exact: true,
  });
  await seeds.fill("办公资料");
  await candidates.fill("办公资料下载\n办公模板");
  await page.getByRole("button", { name: "检索流量词", exact: true }).click();
  await page.getByRole("button", { name: "正在检索…", exact: true }).waitFor();
  assert(await reset.isEnabled());
  const keywordNext = footer.getByRole("button", {
    name: "下一步：选择文件",
    exact: true,
  });
  const [kr, kn] = await Promise.all([
    reset.boundingBox(),
    keywordNext.boundingBox(),
  ]);
  assert(kr && kn && kr.x + kr.width <= kn.x && Math.abs(kr.y - kn.y) < 2);
  await mkdir("/private/tmp/panxu-intake-reset", { recursive: true });
  await page.screenshot({
    path: "/private/tmp/panxu-intake-reset/keywords.png",
  });
  await reset.click();
  await emptyInfo();
  await page.evaluate(() => window.__releaseOldLookup());
  await fill("重置后的新资料");
  await next.click();
  assert.equal(await seeds.inputValue(), "");
  assert.equal(await candidates.inputValue(), "");
  await seeds.fill("新搜索词");
  await candidates.fill("新候选词");
  await footer
    .getByRole("button", { name: "上一步：资源信息", exact: true })
    .click();
  await reset.click();
  await emptyInfo();
  await page.reload();
  await emptyInfo();
  await page.screenshot({ path: "/private/tmp/panxu-intake-reset/info.png" });
  await fill("刷新后的资料");
  await next.click();
  assert.equal(await seeds.inputValue(), "");
  assert.equal(await candidates.inputValue(), "");
  assert.deepEqual(errors, []);
  assert.equal(await page.locator("vite-error-overlay").count(), 0);
  console.log(
    JSON.stringify({
      windowId,
      passed: [
        "重复资源仍可重置",
        "前两步均有按钮且位于下一步左侧",
        "清空资料与封面",
        "清空搜索词和候选词",
        "旧异步结果不回填",
        "重置后刷新不恢复旧输入",
      ],
      pageErrors: errors,
    }),
  );
}
