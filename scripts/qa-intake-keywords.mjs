import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

async function pasteText(input, text) {
  await input.evaluate((node, content) => {
    node.setSelectionRange(node.value.length, node.value.length);
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", content);
    node.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, text);
}

export async function run({ page, windowId }) {
  console.log(JSON.stringify({ windowId }));
  const screenshot = resolve("/tmp", "panxu-intake-keywords");
  await mkdir(screenshot, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.route("**/src/api/client.ts*", async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    const mock = body.replace(
      "return window.panxu.invoke",
      `
      if(method==="snapshot") return window.panxu.invoke(method,args).then(snapshot => ({
        ...snapshot, resources: [], accounts: [{id:"intake-keyword-fixture",alias:"夸克录入账号",provider:"quark",enabled:true,status:"connected",isDefault:true,defaultDirectory:"/盘序资料"}]
      }));
      if(method==="share.validate") return Promise.resolve({status:"valid",message:"连接有效",checkedAt:new Date().toISOString()});
      if(method==="resource.similar") return Promise.resolve([]);
      if(method==="resource.intakeOptions") return Promise.resolve({categories:["效率办公"],directories:["/盘序资料"]});
      if(method==="websiteAccounts.list") {
        window.__keywordAccountProvider = args?.provider;
        return Promise.resolve([{
          id:"web_marketing_fixture",alias:"百度营销测试号",provider:"baidu-marketing",
          status:window.__keywordAccountExpired ? "expired" : "connected",uid:"12345"
        }]);
      }
      if(method==="websiteAccounts.login") throw new Error("录入页应该复用已有账号");
      if(method==="resource.keywordCheckSources") {
        window.__keywordSourceChecks = (window.__keywordSourceChecks || 0) + 1;
        const result = {checkedAt:new Date().toISOString(),sources:{
          "baidu-marketing":{status:"ready",message:"已有账号可用"},
          baidu:{status:"ready",message:"百度搜索页面可用"},
          "5118":{status:"ready",message:"5118页面可用"}
        }};
        return new Promise(resolve => { window.__releaseSourceCheck = () => resolve(result); });
      }
      if(method==="resource.keywordOpen5118") {
        window.__keywordInternal5118 = (window.__keywordInternal5118 || 0) + 1;
        return Promise.resolve();
      }
      if(method==="resource.keywordLookup") {
        window.__keywordLookups = (window.__keywordLookups || 0) + 1;
        window.__keywordSeeds = args.seeds;
        window.__keywordAccount = args.baiduAccountId;
        const candidates = [
          {word:"商业分析简历",sources:["suggest","5118"],seeds:["商业分析","校招简历"]}
        ];
        if (window.__failLookup) return Promise.reject(new Error("检索测试异常"));
        if (window.__emptyLookup) return Promise.resolve({candidates:[],issues:[]});
        const issues = [];
        if (args.baiduAccountId && window.__expireOnQuery) {
          window.__keywordAccountExpired = true;
          issues.push({channel:"baidu-marketing",code:"login_required",message:"百度营销账号不可用，请在账号管理中检查登录后重试。"});
          issues.push({channel:"baidu",seed:"校招简历",message:"相关搜索暂不可用"});
          issues.push({channel:"5118",seed:"商业分析",code:"login_required",message:"5118 要求登录后查询。请打开 5118，登录后将查到的词粘贴到候选关键词。"});
        } else if (args.baiduAccountId) {
          candidates.push({word:"商业分析简历模板",sources:["baidu-marketing"],seeds:["商业分析"]});
        }
        if (window.__holdLookup) return new Promise(resolve => {
          window.__releaseLookup = () => resolve({candidates,issues});
        });
        return Promise.resolve({candidates,issues});
      }
      if(method==="resource.save") {
        window.__keywordSaved = args;
        return Promise.resolve({resourceId:"intake-keyword-fixture",copyId:"fixture",jobId:null});
      }
      if(method==="system.external") {
        window.__keywordExternal = args.url;
        return Promise.resolve(true);
      }
      if(method==="system.copyText") {
        window.__keywordCopied = args.text;
        return Promise.resolve(true);
      }
      if(method==="share.inspect") {
        window.__shareReads = (window.__shareReads || 0) + 1;
        const result = {shareKey:"testintakekeyword",title:"目录资料",parentId:"0",page:1,hasMore:false,
          files:[{id:"auto-read-file",name:"自动读取资料.pdf",parentId:"0",isDirectory:false,size:120}]};
        if (window.__holdShareRead) return new Promise(resolve => { window.__releaseShareRead = () => resolve(result); });
        return Promise.resolve(result);
      }
      if(method==="share.open") {
        window.__shareOpen = (window.__shareOpen || 0) + 1;
        return Promise.resolve(true);
      }
      return window.panxu.invoke`,
    );
    assert.notEqual(mock, body);
    await route.fulfill({
      response,
      body: mock,
      contentType: "application/javascript",
    });
  });
  await page.reload();
  await page
    .getByLabel("网盘分享链接", { exact: true })
    .fill("https://pan.quark.cn/s/testintakekeyword");
  await page
    .getByLabel("资源标题", { exact: true })
    .fill("商业分析实习申请资料");
  await page.getByRole("button", { name: "下一步：检索流量词" }).click();
  await page.getByText("百度营销 · 可用", { exact: true }).waitFor();
  await page.getByText("百度搜索 · 待检查", { exact: true }).waitFor();
  await page.getByText("5118 · 待检查", { exact: true }).waitFor();
  await page.getByRole("button", { name: "复制资源标题" }).click();
  assert.equal(
    await page.evaluate(() => window.__keywordCopied),
    "商业分析实习申请资料",
  );
  assert.equal(
    await page.evaluate(() => window.__keywordAccountProvider),
    "baidu-marketing",
  );
  assert.equal(await page.evaluate(() => window.__keywordLookups ?? 0), 0);
  const seeds = page.getByLabel("搜索词", { exact: true });
  const candidates = page.getByLabel("候选关键词", { exact: true });
  const lookup = page.getByRole("button", { name: "检索流量词", exact: true });
  await candidates.fill("检查来源时需要保留的词");
  await page.getByRole("button", { name: "检查全部来源", exact: true }).click();
  await page.waitForFunction(
    () => typeof window.__releaseSourceCheck === "function",
  );
  assert.equal(
    await page.locator(".intake-keyword-source[data-state=checking]").count(),
    3,
  );
  assert.equal(await lookup.isDisabled(), true);
  assert.equal(await candidates.inputValue(), "检查来源时需要保留的词");
  await page.evaluate(() => window.__releaseSourceCheck());
  await page.getByText("百度搜索 · 可用", { exact: true }).waitFor();
  await page.getByText("5118 · 可用", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__keywordLookups ?? 0), 0);
  const fiveSeeds = [
    "商业分析",
    "校招简历",
    "面试资料",
    "笔试真题",
    "实习指南",
  ];
  await seeds.fill([...fiveSeeds, "职场入门"].join("，"));
  assert.equal(await lookup.isDisabled(), true);
  await page.getByText("一次最多检索 5 个搜索词。", { exact: true }).waitFor();
  await seeds.fill([...fiveSeeds, fiveSeeds[0]].join("，"));
  await candidates.fill("上次检索遗留词\n手工旧词");
  await page.evaluate(() => {
    window.__holdLookup = true;
  });
  await lookup.click();
  await page.waitForFunction(
    () => typeof window.__releaseLookup === "function",
  );
  assert.equal(await candidates.inputValue(), "");
  assert.equal(await candidates.isDisabled(), true);
  assert.equal(
    await page.locator(".intake-keyword-source[data-state=checking]").count(),
    3,
  );
  await page.evaluate(() => {
    window.__holdLookup = false;
    window.__releaseLookup();
  });
  await page.getByText("百度搜索 · 可用", { exact: true }).waitFor();
  assert.equal(
    await page.locator(".intake-keyword-source[data-state=ready] svg").count(),
    3,
  );
  assert.deepEqual(await page.evaluate(() => window.__keywordSeeds), fiveSeeds);
  assert.equal(
    await page.evaluate(() => window.__keywordAccount),
    "web_marketing_fixture",
  );
  assert.equal(await candidates.inputValue(), "商业分析简历\n商业分析简历模板");
  assert.equal(await candidates.evaluate((node) => node.tagName), "TEXTAREA");
  assert.equal(await page.getByRole("table").count(), 0);
  const compactHeight = (await candidates.boundingBox()).height;
  assert.ok(
    compactHeight >= 500,
    `候选框高度应至少500px，实际 ${compactHeight}px`,
  );
  const panels = await page
    .locator(".intake-keywords > .panel")
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const { x, y, width } = node.getBoundingClientRect();
        return { x, y, width };
      }),
    );
  assert.ok(Math.abs(panels[0].y - panels[1].y) <= 1);
  assert.ok(panels[1].x > panels[0].x + panels[0].width);
  assert.ok(
    Math.abs(panels[0].width - panels[1].width) <= 1,
    JSON.stringify(panels),
  );
  const padding = await page.locator(".main-content").evaluate((node) => {
    const styles = getComputedStyle(node);
    return {
      top: parseFloat(styles.paddingTop),
      bottom: parseFloat(styles.paddingBottom),
    };
  });
  assert.equal(padding.top, 16);
  assert.ok(Math.abs(padding.bottom - (32 * 2) / 3) <= 1);
  await page.screenshot({
    path: resolve(screenshot, "intake-keywords-1440.png"),
  });
  await page.setViewportSize({ width: 1920, height: 1080 });
  const geometry = await candidates.evaluate((node) => ({
    height: node.clientHeight,
    remaining:
      node.closest(".workspace-scroll").getBoundingClientRect().bottom -
      node.closest(".intake-keyword-candidate").getBoundingClientRect().bottom,
  }));
  assert.ok(geometry.height > compactHeight + 100, JSON.stringify(geometry));
  assert.ok(Math.abs(geometry.remaining) <= 1, JSON.stringify(geometry));
  await page.screenshot({
    path: resolve(screenshot, "intake-keywords-1920.png"),
  });
  assert.equal(await page.evaluate(() => window.__keywordExternal), undefined);
  await page.evaluate(() => {
    window.__expireOnQuery = true;
  });
  await lookup.click();
  await page.getByText("百度营销 · 需登录", { exact: true }).waitFor();
  assert.equal(
    await page.locator(".intake-keyword-source[data-state=warning]").count(),
    3,
  );
  await page.getByRole("button", { name: "前往账号管理" }).waitFor();
  assert.equal(await candidates.inputValue(), "商业分析简历");
  await page.getByText("查看来源提示（3 项）", { exact: true }).click();
  await page
    .getByText("百度营销账号不可用，请在账号管理中检查登录后重试。", {
      exact: false,
    })
    .waitFor();
  await page.screenshot({
    path: resolve(screenshot, "intake-keywords-partial.png"),
  });
  await page.getByText("查看来源提示（3 项）", { exact: true }).click();
  await lookup.click();
  await page.waitForFunction(() => window.__keywordLookups === 3);
  assert.equal(await page.evaluate(() => window.__keywordAccount), undefined);
  await page.getByText("百度搜索 · 可用", { exact: true }).waitFor();
  await candidates.fill("失败前的旧词");
  await page.evaluate(() => {
    window.__failLookup = true;
  });
  await lookup.click();
  await page.getByText("检索测试异常", { exact: true }).waitFor();
  assert.equal(await candidates.inputValue(), "");
  await page.getByText("百度搜索 · 检索失败", { exact: true }).waitFor();
  await page.evaluate(() => {
    window.__failLookup = false;
    window.__emptyLookup = true;
  });
  await candidates.fill("无结果前的旧词");
  await lookup.click();
  await page.getByText("百度搜索 · 无结果", { exact: true }).waitFor();
  assert.equal(await candidates.inputValue(), "");
  await page.getByRole("button", { name: "打开 5118" }).click();
  assert.equal(await page.evaluate(() => window.__keywordInternal5118), 1);
  assert.equal(await page.evaluate(() => window.__keywordExternal), undefined);
  await candidates.fill(
    Array.from({ length: 101 }, (_, i) => `关键词${i + 1}`).join("\n"),
  );
  assert.equal(
    await page.getByRole("button", { name: "保存资料草稿" }).isDisabled(),
    true,
  );
  assert.ok(
    await candidates.evaluate((node) => node.scrollHeight > node.clientHeight),
  );
  await candidates.fill("  商业分析简历　\n商业分析简历\n");
  await pasteText(candidates, "　商业分析校招面试   \r\n");
  assert.equal(
    await candidates.inputValue(),
    "  商业分析简历　\n商业分析简历\n商业分析校招面试",
  );
  await candidates.fill(`${await candidates.inputValue()}\n`);
  await pasteText(candidates, "关键词\t热度\n 商业分析校招面试 \t80");
  await page.getByRole("heading", { name: "候选关键词" }).click();
  const editedText = "商业分析简历\n商业分析校招面试";
  assert.equal(await candidates.inputValue(), editedText);
  await page.screenshot({ path: resolve(screenshot, "intake-keywords.png") });
  await page.evaluate(() => {
    window.__holdShareRead = true;
  });
  await page.getByRole("button", { name: "下一步：选择文件" }).click();
  await page.waitForFunction(
    () => typeof window.__releaseShareRead === "function",
  );
  assert.equal(await page.evaluate(() => window.__shareReads), 1);
  await page.getByRole("button", { name: "打开官方分享" }).click();
  assert.equal(await page.evaluate(() => window.__shareOpen), 1);
  assert.equal(await page.evaluate(() => window.__shareReads), 1);
  await page.evaluate(() => {
    window.__holdShareRead = false;
    window.__releaseShareRead();
  });
  await page.getByText("自动读取资料.pdf", { exact: true }).waitFor();
  await page.screenshot({ path: resolve(screenshot, "intake-auto-share.png") });
  assert.equal(await page.evaluate(() => window.__shareReads), 1);
  await page.getByRole("button", { name: "上一步：流量词" }).click();
  assert.equal(await candidates.inputValue(), editedText);
  await page.getByRole("button", { name: "下一步：选择文件" }).click();
  await page.getByText("自动读取资料.pdf", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__shareReads), 1);
  await page.getByRole("button", { name: "上一步：流量词" }).click();
  await page.reload();
  await page.getByRole("button", { name: "下一步：检索流量词" }).click();
  assert.equal(await candidates.inputValue(), editedText);
  await page.getByRole("button", { name: "保存资料草稿" }).click();
  await page.waitForFunction(() => !!window.__keywordSaved);
  const saved = await page.evaluate(() => window.__keywordSaved);
  assert.deepEqual(saved.searchKeywords, ["商业分析简历", "商业分析校招面试"]);
  assert.equal(saved.enqueue, false);
  assert.deepEqual(browserErrors, []);
  console.log(
    JSON.stringify({
      screenshot: resolve(screenshot, "intake-keywords.png"),
      savedKeywords: saved.searchKeywords,
    }),
  );
}
