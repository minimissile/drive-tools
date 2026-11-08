import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { chromium, type Browser } from "playwright-core";
import { bilibiliEditorUrl, type BilibiliKind } from "../shared/bilibili";
import {
  waitForBilibiliUpload,
  type BilibiliUploadProbe,
} from "../core/bilibili/upload-page";
import { bilibiliReopenedPreparation } from "../core/bilibili/editor-page";

const script = buildSync({
  entryPoints: [
    fileURLToPath(new URL("../core/bilibili/editor-page.ts", import.meta.url)),
  ],
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  globalName: "BilibiliEditor",
  target: "chrome120",
}).outputFiles[0].text;
const uploadScript = buildSync({
  entryPoints: [
    fileURLToPath(new URL("../core/bilibili/upload-page.ts", import.meta.url)),
  ],
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  globalName: "BilibiliUpload",
  target: "chrome120",
}).outputFiles[0].text;
let browser: Browser;
before(async () => {
  browser = await chromium.launch({
    executablePath:
      process.env.PANXU_CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
});
after(async () => {
  await browser?.close();
});

/** Only local HTML fixtures in an isolated browser. No account, app session, or remote writes. */
async function setup(
  kind: BilibiliKind,
  html: string,
  target = bilibiliEditorUrl(kind),
) {
  const context = await browser.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();
  await page.route("**/*", (route) =>
    route.request().isNavigationRequest()
      ? route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: `<!doctype html><meta charset=utf-8><style>[contenteditable]{min-height:30px}</style>${html}<button id=publish>发布</button><button id=save>保存草稿</button><script>window.clicks=[];document.querySelectorAll('button').forEach(button=>button.onclick=()=>window.clicks.push(button.id))</script>`,
        })
      : route.abort(),
  );
  await page.goto(target);
  await page.addScriptTag({ content: script });
  await page.addScriptTag({ content: uploadScript });
  const fill = async (
    input: {
      title?: string;
      text?: string;
      tags?: string[];
      automaticVideoTitle?: string;
    } = {},
  ) =>
    page.evaluate(
      (input) => (window as any).BilibiliEditor.bilibiliFillPage(input),
      {
        kind,
        title: "真实资料目录",
        text: "先核对资料用途，再按目录选择练习。",
        tags: [],
        ...input,
      },
    ) as Promise<{ fields: string[]; missing: string[] }>;
  const clicks = () => page.evaluate(() => (window as any).clicks as string[]);
  const probe = (allowFallback = true) =>
    page.evaluate(
      (input) => (window as any).BilibiliUpload.bilibiliUploadPage(input),
      {
        kind: "video",
        editorUrl: bilibiliEditorUrl("video"),
        marker: "data-bili-upload-fixture",
        allowFallback,
      },
    ) as Promise<BilibiliUploadProbe>;
  return { context, page, fill, clicks, probe };
}

const activeUpload =
  '<div class="upload-body-content"><div class="upload-wrp"><div class="bcc-upload"><div class="bcc-upload-wrapper"><input id="active-video" type="file" accept=".mp4,.mov" style="display:none">点击上传或将视频拖拽到此区域<br>上传视频</div></div></div></div>';
const microUpload =
  '<micro-app><input name="buploader" id="micro-video" type="file" accept=".mp4,.mov" style="display:none"><input name="buploader" type="file" accept=".txt" style="display:none"></micro-app>';
test("已观测上传区优先于额外buploader，隐藏input通过可见祖先定位而非DOM序号", async () => {
  const f = await setup("video", microUpload + activeUpload);
  try {
    const result = await f.probe(false);
    assert.equal(result.ready, true);
    assert.equal(
      await f.page.locator("[data-bili-upload-fixture]").getAttribute("id"),
      "active-video",
    );
    assert.equal(
      await f.page
        .locator("#micro-video")
        .getAttribute("data-bili-upload-fixture"),
      null,
    );
    assert.equal(await f.page.locator("input[type=file]").count(), 3);
    assert.deepEqual(await f.clicks(), []);
  } finally {
    await f.context.close();
  }
});
test("慢挂载时只等待已知上传区，不因早期唯一隐藏micro-app输入而误选", async () => {
  const f = await setup("video", microUpload);
  try {
    assert.equal((await f.probe(false)).ready, false);
    await f.page.evaluate((html) => {
      setTimeout(() => document.body.insertAdjacentHTML("beforeend", html), 80);
    }, activeUpload);
    const started = Date.now();
    assert.equal(
      await waitForBilibiliUpload(
        () => f.probe(false),
        () => {},
        { timeoutMs: 1000, pollMs: 20 },
      ),
      true,
    );
    assert(Date.now() - started >= 50);
    assert.equal(
      await f.page.locator("[data-bili-upload-fixture]").getAttribute("id"),
      "active-video",
    );
    assert.equal(
      await f.page
        .locator("#micro-video")
        .getAttribute("data-bili-upload-fixture"),
      null,
    );
  } finally {
    await f.context.close();
  }
});
test("未知区域多个视频输入等待到期后仍拒绝，只有全局唯一输入可fallback", async () => {
  const ambiguous = await setup(
    "video",
    microUpload + '<input type="file" accept="video/*">',
  );
  try {
    assert.equal(
      await waitForBilibiliUpload(
        () => ambiguous.probe(false),
        () => {},
        { timeoutMs: 80, pollMs: 20 },
      ),
      false,
    );
    assert.equal((await ambiguous.probe()).reason, "ambiguous");
    assert.equal(
      await ambiguous.page.locator("[data-bili-upload-fixture]").count(),
      0,
    );
  } finally {
    await ambiguous.context.close();
  }
  const unique = await setup(
    "video",
    '<input id="unique-video" type="file" accept="video/*">',
  );
  try {
    assert.equal((await unique.probe(false)).ready, false);
    assert.equal((await unique.probe()).ready, true);
    assert.equal(
      await unique.page
        .locator("[data-bili-upload-fixture]")
        .getAttribute("id"),
      "unique-video",
    );
  } finally {
    await unique.context.close();
  }
});
test("等待已知区超时后不回退到唯一隐藏micro-app输入，未知隐藏图片同样拒绝", async () => {
  const hidden = await setup("video", microUpload);
  try {
    assert.equal(
      await waitForBilibiliUpload(
        () => hidden.probe(false),
        () => {},
        { timeoutMs: 60, pollMs: 20 },
      ),
      false,
    );
    assert.equal((await hidden.probe()).ready, false);
    assert.equal(
      await hidden.page.locator("[data-bili-upload-fixture]").count(),
      0,
    );
  } finally {
    await hidden.context.close();
  }
  for (const [kind, html] of [
    ["video", '<input type="file" accept="video/*" style="visibility:hidden">'],
    [
      "image",
      '<div>上传图片<input type="file" accept="image/png,image/jpeg" style="display:none"></div>',
    ],
  ] as const) {
    const f = await setup("video", html);
    try {
      const result = await f.page.evaluate(
        (kind) =>
          (window as any).BilibiliUpload.bilibiliUploadPage({
            kind,
            editorUrl: location.href,
            marker: "data-bili-upload-fixture",
          }),
        kind,
      );
      assert.equal(result.ready, false);
      assert.equal(
        await f.page.locator("[data-bili-upload-fixture]").count(),
        0,
      );
    } finally {
      await f.context.close();
    }
  }
  const mixed = await setup(
    "video",
    microUpload + '<input type="file" accept="video/*">',
  );
  try {
    assert.equal((await mixed.probe()).reason, "ambiguous");
    assert.equal(
      await mixed.page.locator("[data-bili-upload-fixture]").count(),
      0,
    );
  } finally {
    await mixed.context.close();
  }
});

test("上传控件等待在工作空间generation改变后停止，不继续轮询或选择", async () => {
  let generation = 0,
    reads = 0;
  const pending = waitForBilibiliUpload(
    async () => {
      reads++;
      return { ready: false, reason: "waiting" };
    },
    () => {
      if (generation) throw new Error("workspace-changed");
    },
    { timeoutMs: 1000, pollMs: 20 },
  );
  setTimeout(() => {
    generation++;
  }, 35);
  await assert.rejects(pending, /workspace-changed/);
  assert(reads > 0 && reads < 5);
});

test("本操作自动视频文件名可替换成稿件标题，实测Quill简介写入且不碰clipboard", async () => {
  const hash = "a".repeat(64);
  const f = await setup(
    "video",
    `<input placeholder="请输入稿件标题" maxlength="80" value="${hash}"><div contenteditable=true class="ql-editor ql-blank notranslate" data-placeholder="填写更全面的相关信息，让更多的人能找到你的视频吧"></div><div contenteditable=true class="ql-clipboard">保留剪贴板区域</div>`,
  );
  try {
    const result = await f.fill({ automaticVideoTitle: hash });
    assert.deepEqual(result.fields, ["标题", "简介"]);
    assert.deepEqual(result.missing, []);
    assert.equal(await f.page.locator("input").inputValue(), "真实资料目录");
    assert.equal(
      await f.page.locator(".ql-editor").innerText(),
      "先核对资料用途，再按目录选择练习。",
    );
    assert.equal(
      await f.page.locator(".ql-clipboard").innerText(),
      "保留剪贴板区域",
    );
    assert.deepEqual(await f.clicks(), []);
  } finally {
    await f.context.close();
  }
  for (const initial of ["b".repeat(64), "人工编辑的标题"]) {
    const g = await setup(
      "video",
      `<input placeholder="请输入稿件标题" value="${initial}"><textarea placeholder="视频简介"></textarea>`,
    );
    try {
      assert(
        (await g.fill({ automaticVideoTitle: hash })).missing.includes("标题"),
      );
      assert.equal(await g.page.locator("input").inputValue(), initial);
    } finally {
      await g.context.close();
    }
  }
});
const tagMarkup =
  '<div class="tag-input-wrp"><div class="input-container"><div class="tag-pre-wrp"><p class="label-item-v2-content">生活记录</p><p class="label-item-v2-content">记录</p><p class="label-item-v2-content">学习</p></div><input id="tag-active" placeholder="按回车键Enter创建标签" maxlength="20"></div></div><input id="tag-batch" placeholder="按回车键Enter创建标签" maxlength="20" style="display:none">';
test("标签保留默认已选项，只操作可见输入并逐项等待异步chip回读", async () => {
  const f = await setup(
    "video",
    '<input placeholder="请输入稿件标题"><textarea placeholder="视频简介"></textarea>' +
      tagMarkup +
      `<script>window.tagWrites=[];document.getElementById('tag-active').addEventListener('keydown',event=>{if(event.key!=='Enter')return; const input=event.currentTarget;const value=input.value;setTimeout(()=>{const chip=document.createElement('p');chip.className='label-item-v2-content';chip.textContent=value;document.querySelector('.tag-pre-wrp').append(chip);input.value='';window.tagWrites.push(value);},70);});</script>`,
  );
  try {
    const result = await f.fill({
      tags: ["学习", "MBTI", "九型人格", "职业规划"],
    });
    assert(result.fields.includes("标签"));
    assert(!result.missing.includes("标签"));
    assert.deepEqual(
      await f.page.locator(".label-item-v2-content").allTextContents(),
      ["生活记录", "记录", "学习", "MBTI", "九型人格", "职业规划"],
    );
    assert.deepEqual(await f.page.evaluate(() => (window as any).tagWrites), [
      "MBTI",
      "九型人格",
      "职业规划",
    ]);
    assert.equal(await f.page.locator("#tag-batch").inputValue(), "");
    assert.deepEqual(await f.clicks(), []);
  } finally {
    await f.context.close();
  }
});
test("标签不覆盖正在输入的人工内容，也不在表单内发送Enter", async () => {
  for (const form of [false, true]) {
    const markup = form ? `<form>${tagMarkup}</form>` : tagMarkup;
    const f = await setup(
      "video",
      '<input placeholder="请输入稿件标题"><textarea placeholder="视频简介"></textarea>' +
        markup,
    );
    try {
      if (!form) await f.page.locator("#tag-active").fill("尚未完成的人工标签");
      assert((await f.fill({ tags: ["MBTI"] })).missing.includes("标签"));
      assert.equal(
        await f.page.locator("#tag-active").inputValue(),
        form ? "" : "尚未完成的人工标签",
      );
      assert.deepEqual(
        await f.page.locator(".label-item-v2-content").allTextContents(),
        ["生活记录", "记录", "学习"],
      );
      assert.deepEqual(await f.clicks(), []);
    } finally {
      await f.context.close();
    }
  }
});
test("上传失败与人工验证读取真实状态区域，文件或编辑表单存在不当作上传完成", async () => {
  for (const [html, expected] of [
    [
      '<div class="task-status task-status-fail"><span class="text">上传失败</span></div><div class="file-item-content-status-text file-item-content-status-text-fail"><span class="fail">验证码已关闭</span></div>',
      "verification",
    ],
    [
      '<div class="task-status task-status-fail"><span class="text">上传失败</span></div>',
      "failed",
    ],
    [
      '<div class="task-status"><span class="text">上传中</span></div>',
      "uploading",
    ],
    [
      '<div class="task-status"><span class="text">上传完成</span></div>',
      "completed",
    ],
    [
      '<input type="file" accept="video/*"><input placeholder="标题"><p>上传完成</p><div class="task-status-fail" style="display:none"><span class="text">上传失败</span></div>',
      "unknown",
    ],
  ] as const) {
    const f = await setup("video", html);
    try {
      const status = await f.page.evaluate(() =>
        (window as any).BilibiliEditor.bilibiliVideoUploadPage(),
      );
      assert.equal(status.state, expected);
      if (expected === "verification")
        assert.match(status.message, /人工验证|验证/);
      assert.deepEqual(await f.clicks(), []);
    } finally {
      await f.context.close();
    }
  }
});
test("重新打开既有窗口不会复用旧填写回执冒充本轮字段核验", () => {
  const receipt = bilibiliReopenedPreparation(
    bilibiliEditorUrl("video"),
    "官网要求人工验证。",
  );
  assert.equal(receipt.status, "partial");
  assert.deepEqual(receipt.filledFields, []);
  assert.equal(receipt.mediaSelected, false);
  assert.equal(receipt.imageSelected, false);
  assert.match(receipt.message, /未重新核对|未重新选择文件/);
  assert.match(receipt.message, /人工验证/);
});

test("视频标题简介写入并回读，标签待官网补充，不点击发布或保存", async () => {
  const f = await setup(
    "video",
    '<input placeholder="请输入稿件标题"><textarea placeholder="视频简介"></textarea>',
  );
  try {
    const result = await f.fill({ tags: ["学习资料"] });
    assert.deepEqual(result.fields, ["标题", "简介"]);
    assert.deepEqual(result.missing, ["标签"]);
    assert.equal(await f.page.locator("input").inputValue(), "真实资料目录");
    assert.equal(
      await f.page.locator("textarea").inputValue(),
      "先核对资料用途，再按目录选择练习。",
    );
    assert.deepEqual(await f.clicks(), []);
  } finally {
    await f.context.close();
  }
});
test("动态在唯一编辑框写入标题与正文，HTML仅作为文字不执行", async () => {
  const f = await setup(
    "dynamic",
    '<div class="bili-rich-textarea__browser" contenteditable=true></div>',
  );
  try {
    const result = await f.fill({
      title: "目录分享",
      text: '<img src=x onerror="window.injected=true">',
    });
    assert.deepEqual(result.fields, ["正文"]);
    assert.deepEqual(result.missing, []);
    assert.match(
      await f.page.locator("[contenteditable]").innerText(),
      /<img src=x/,
    );
    assert.equal(await f.page.locator("[contenteditable] img").count(), 0);
    assert.equal(
      await f.page.evaluate(() => (window as any).injected),
      undefined,
    );
    assert.deepEqual(await f.clicks(), []);
  } finally {
    await f.context.close();
  }
});
test("专栏保留官网现有文字，不把其它稿件标题覆盖成当前标题", async () => {
  const f = await setup(
    "article",
    '<input placeholder="请输入标题" value="正在手工编辑的标题"><div class="ProseMirror" contenteditable=true></div>',
  );
  try {
    const result = await f.fill();
    assert.deepEqual(result.fields, ["正文"]);
    assert.deepEqual(result.missing, ["标题"]);
    assert.equal(
      await f.page.locator("input").inputValue(),
      "正在手工编辑的标题",
    );
    assert.deepEqual(await f.clicks(), []);
  } finally {
    await f.context.close();
  }
});
test("不明确或已离开当前编辑器时不填写任何字段", async () => {
  const moved = await setup(
    "video",
    '<input placeholder="标题"><textarea placeholder="视频简介"></textarea>',
    "https://www.bilibili.com/video/BV1RK3t6wEC1/",
  );
  try {
    assert.deepEqual((await moved.fill()).fields, []);
    assert.equal(await moved.page.locator("input").inputValue(), "");
    assert.equal(await moved.page.locator("textarea").inputValue(), "");
    assert.deepEqual(await moved.clicks(), []);
  } finally {
    await moved.context.close();
  }
  const ambiguous = await setup(
    "dynamic",
    '<textarea placeholder="分享动态"></textarea><textarea placeholder="分享动态"></textarea>',
  );
  try {
    const result = await ambiguous.fill();
    assert.deepEqual(result.fields, []);
    assert.deepEqual(result.missing, ["正文"]);
    assert.deepEqual(
      await ambiguous.page
        .locator("textarea")
        .evaluateAll((elements) =>
          elements.map((element) => (element as HTMLTextAreaElement).value),
        ),
      ["", ""],
    );
  } finally {
    await ambiguous.context.close();
  }
});
