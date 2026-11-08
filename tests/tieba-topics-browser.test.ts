import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chromium, type Browser } from "playwright-core";
import { tiebaTopicPublisher } from "../core/tieba/topic-browser";
import { tiebaHomeFixture } from "./tieba-autocare-browser-fixture";
import type { TiebaTopicPayload } from "../core/tieba/topic-types";
import type { WebsiteAccount } from "../shared/website-accounts";
import {
  topicUnknown,
  tiebaTopicPageScript,
  type TiebaTopicPageSnapshot,
} from "../core/tieba/topic-page";
const body =
  "整理本地资料时，可以先列出最常使用的三个场景，再按照场景建立少量主目录。每份文件保留一个位置，用标签区分类型，避免同一文件复制多份。每周检查收件目录，把临时文件归档。记录一次实际查找所需时间，再根据结果调整目录。";
const title = "整理资料目录的几个步骤";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL0sAAAAASUVORK5CYII=",
  "base64",
);
const payload = (images = false): TiebaTopicPayload => ({
  forumId: "100",
  forumName: "整理资料",
  title,
  body,
  images: images
    ? [
        {
          name: "资料截图.png",
          mime: "image/png",
          bytes: png,
          sha256: createHash("sha256").update(png).digest("hex"),
        },
      ]
    : [],
});
const account: WebsiteAccount = {
  id: "web_topic_fixture",
  provider: "tieba",
  alias: "主题fixture",
  uid: "111",
  status: "connected",
  createdAt: "2026-11-07T00:00:00Z",
  updatedAt: "2026-11-07T00:00:00Z",
};
type Mode =
  | "success"
  | "textarea"
  | "duplicate"
  | "occupied"
  | "wrong-forum"
  | "challenge"
  | "unknown"
  | "review"
  | "wrong-author"
  | "missing-body"
  | "upload-change"
  | "wrong-image"
  | "redirect";
let browser: Browser;
before(async () => {
  browser = await chromium.launch({
    headless: true,
    executablePath:
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    args: ["--no-sandbox"],
  });
});
after(async () => {
  await browser?.close();
});
const escape = (v: string) =>
  v
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
async function fixture(
  mode: Mode = "success",
  options: {
    own?: boolean;
    createdAt?: string;
    images?: boolean;
    imageCount?: number;
    ai?: boolean;
    declaration?: boolean;
    toolbar?: boolean;
    nestedListAuthor?: boolean;
    conflictingListAuthor?: boolean;
    linkHref?: string;
    literalLinkLabel?: boolean;
    plainLink?: boolean;
  } = {},
) {
  const context = await browser.newContext();
  let uid = "111",
    submissions = 0,
    uploads = 0,
    checkpoints = 0,
    guards = 0,
    uploadGuardFailure = false,
    hasPosted = false,
    submittedDeclaration = "",
    localOpens = 0,
    watermarkNext = 0,
    paidClicks = 0,
    networkClicks = 0;
  const p = payload(options.images || !!options.imageCount);
  p.aiGenerated = options.ai === true;
  const cloudLink = "https://pan.baidu.com/s/1Fixture";
  if (options.linkHref) p.body += `\n网盘链接：${cloudLink}\n提取码：a1b2`;
  const postBody = () =>
    options.linkHref && !options.plainLink
      ? escape(p.body).replace(
          cloudLink,
          `<a href="${escape(options.linkHref)}">${options.literalLinkLabel ? cloudLink : "网页链接"}</a>`,
        )
      : escape(p.body);
  if (options.imageCount === 2) {
    const bytes = Buffer.concat([png, Buffer.from([0])]);
    p.images.push({
      name: "第二份资料.png",
      mime: "image/png",
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  const urls = p.images.map(
    (_, n) => `https://tiebapic.baidu.com/forum/pic/item/topicfixture${n}.png`,
  );
  const forum = () =>
    `<!doctype html><meta charset="utf-8"><script>window.PageData={user:{user_id:${JSON.stringify(uid)},is_login:1},forum:{id:'${mode === "wrong-forum" ? "999" : "100"}',name:'整理资料'}};</script><ul id="thread_list">${options.own || hasPosted ? `<li class="j_thread_list" data-field='{"id":1000,"author_id":111,"reply_num":0}'><a class="j_th_tit" href="/p/1000">${title}</a></li>` : '<li class="thread_list_empty">暂无主题</li>'}</ul><div id="tb_rich_poster_container"><input name="title" class="j_title_input" value="${mode === "occupied" ? "官网旧草稿" : ""}">${mode === "textarea" ? '<textarea name="content"></textarea>' : '<div id="ueditor_replace" contenteditable="true"></div>'}${options.toolbar ? '<div class="edui-btn-image" style="width:40px;height:24px"><div class="edui-icon-image"></div></div><div class="edui-dialog-container"></div>' : '<input type="file" accept="image/png,image/jpeg" multiple>'}${options.declaration ? '<span class="ai-entrance"><span class="ai-entrance-text">内容声明</span></span><div id="ai-entrance-select-box" style="display:none"><div class="select-box-item">贴子含AI内容</div><div class="select-box-item">贴子原创声明</div></div>' : ""}<a class="poster_submit" href="javascript:;">发表</a>${mode === "duplicate" ? '<a class="poster_submit" href="javascript:;">发表</a>' : ""}</div>${mode === "challenge" ? '<div id="captcha">安全验证</div>' : ""}<script>if(document.querySelector('.ai-entrance')){document.querySelector('.ai-entrance').onclick=()=>{document.querySelector('#ai-entrance-select-box').style.display='block';};document.querySelector('#ai-entrance-select-box .select-box-item').onclick=e=>{document.querySelector('.ai-entrance-text').textContent=e.target.textContent;document.querySelector('#ai-entrance-select-box').style.display='none';};}function bindInput(input){input.onchange=async e=>{const r=await fetch('/fixture-upload',{method:'POST',body:[...e.target.files].map(f=>f.name).join('|')});const list=await r.json();for(const u of list){const i=document.createElement('img');i.src=u;document.querySelector('#ueditor_replace').appendChild(i);}};}const direct=document.querySelector('input[type=file]');if(direct)bindInput(direct);if(document.querySelector('.edui-btn-image')){document.querySelector('.edui-btn-image').onclick=()=>{document.querySelector('.edui-dialog-container').innerHTML='<div class=\"edui-dropdown-menu edui-popup\"><div class=\"edui-popup-body\"><ul class=\"layer_btn_list\"><li class=\"from_upload\"><a href=\"javascript: void(0);\" class=\"pic_upload_container\">本地上传</a><a>icon</a></li><li class=\"from_web\"><a>网络图片</a></li></ul><div class=\"upload_container\" style=\"display:none\"><div class=\"water_image_selecter_wrap\"><div class=\"slide_item no_water slide_item_active\">无水印</div><div class=\"slide_item\"><a class=\"need_buy_link\">付费水印</a></div></div><div class=\"next_step\">下一步</div></div></div></div>';const popup=document.querySelector('.edui-dialog-container');popup.querySelector('.pic_upload_container').onclick=()=>{fetch('/fixture-local');popup.querySelector('.upload_container').style.display='block';};popup.querySelector('.from_web').onclick=()=>fetch('/fixture-network');popup.querySelector('.need_buy_link').onclick=()=>fetch('/fixture-paid');popup.querySelector('.no_water').onclick=e=>{e.currentTarget.classList.add('slide_item_active');};popup.querySelector('.next_step').onclick=()=>{fetch('/fixture-next');const input=document.createElement('input');input.type='file';input.accept='image/png,image/jpeg';input.multiple=true;input.style.display='none';bindInput(input);input.click();};};}document.querySelector('.poster_submit').onclick=async e=>{e.preventDefault();await fetch('/fixture-submit',{method:'POST',body:document.querySelector('.ai-entrance-text')?.textContent||''});${mode === "unknown" ? "" : mode === "review" ? "const d=document.createElement('div');d.className='ui-dialog';d.textContent='主题发布成功，正在等待审核';document.body.appendChild(d);" : "location.href='/p/1000';"}};</script>`;
  const thread = () =>
    `<!doctype html><meta charset="utf-8"><script>window.PageData={user:{user_id:${JSON.stringify(uid)},is_login:1},forum:{id:'100',name:'整理资料'},thread:{thread_id:'1000'}};</script><h3 class="core_title_txt">${title}</h3><div id="j_p_postlist"><div class="l_post" data-field='${JSON.stringify({ author: { user_id: mode === "wrong-author" ? "222" : "111" }, content: { post_id: "10001", post_no: 1, date: options.createdAt ?? new Date().toISOString() } })}'>${mode === "missing-body" ? "" : `<div class="d_post_content">${escape(body)}${urls.map((u) => `<img src="${mode === "wrong-image" ? u.replace("topicfixture", "wrongfixture") : u}">`).join("")}</div>`}</div></div>`;
  await context.route("**/*", async (route) => {
    const u = new URL(route.request().url());
    if (u.origin === "https://tieba.baidu.com") {
      if (
        u.pathname === "/fixture-local" ||
        u.pathname === "/fixture-next" ||
        u.pathname === "/fixture-paid" ||
        u.pathname === "/fixture-network"
      ) {
        if (u.pathname === "/fixture-local") localOpens++;
        if (u.pathname === "/fixture-next") watermarkNext++;
        if (u.pathname === "/fixture-paid") paidClicks++;
        if (u.pathname === "/fixture-network") networkClicks++;
        await route.fulfill({ body: "ok" });
      } else if (u.pathname === "/fixture-upload") {
        uploads++;
        if (mode === "upload-change") uid = "999";
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify(urls.slice(uploads - 1, uploads)),
        });
      } else if (u.pathname === "/fixture-submit") {
        submissions++;
        submittedDeclaration = route.request().postData() ?? "";
        hasPosted = true;
        await route.fulfill({ body: "ok" });
      } else if (u.pathname === "/f") {
        if (mode === "redirect")
          await route.fulfill({
            status: 302,
            headers: { location: "https://example.invalid/" },
          });
        else {
          let html = forum();
          if (options.nestedListAuthor || options.conflictingListAuthor) {
            if (options.nestedListAuthor)
              html = html.replace(',"author_id":111', "");
            html = html.replace(
              "</li>",
              `<span class="tb_icon_author" data-field='{"user_id":${options.conflictingListAuthor ? 222 : 111}}'></span></li>`,
            );
          }
          await route.fulfill({ contentType: "text/html", body: html });
        }
      } else if (u.pathname === "/p/1000")
        await route.fulfill({
          contentType: "text/html",
          body: thread().replace(escape(body), postBody()),
        });
      else
        await route.fulfill({
          contentType: "text/html",
          body: tiebaHomeFixture(uid),
        });
    } else await route.abort();
  });
  const old = await context.newPage();
  await old.setContent("<title>user existing tab</title><p>kept</p>");
  const adapter = tiebaTopicPublisher(
    async (_account, action) => action(context),
    { pageTimeoutMs: 1000, resultTimeoutMs: 800 },
  );
  const publish = () =>
    adapter.publish(
      account,
      "111",
      p,
      async () => {
        checkpoints++;
      },
      async () => {
        guards++;
        if (uploadGuardFailure && uploads > 0)
          throw Error("用户撤销原主题范围");
      },
    );
  return {
    context,
    adapter,
    p,
    old,
    publish,
    urls,
    get uploadPathCounts() {
      return { localOpens, watermarkNext, paidClicks, networkClicks };
    },
    get submittedDeclaration() {
      return submittedDeclaration;
    },
    get counts() {
      return { submissions, uploads, checkpoints, guards };
    },
    set guardFailure(v: boolean) {
      uploadGuardFailure = v;
    },
    async clean() {
      assert.equal(context.pages().length, 1);
      assert.equal(context.pages()[0], old);
      assert.equal(await old.title(), "user existing tab");
      await context.close();
    },
  };
}
test("official topic editor publishes native text once and verifies real original post evidence", async () => {
  const f = await fixture();
  try {
    const r = await f.publish();
    assert.equal(r.status, "verified");
    assert.equal(r.threadId, "1000");
    assert.equal(r.postId, "10001");
    assert.equal(r.authorUid, "111");
    assert.equal(r.body, body);
    assert.equal(r.url, "https://tieba.baidu.com/p/1000?pid=10001#10001");
    assert.deepEqual(f.counts, {
      submissions: 1,
      uploads: 0,
      checkpoints: 1,
      guards: 1,
    });
  } finally {
    await f.clean();
  }
});
test("native textarea topic editor is supported without changing body", async () => {
  const f = await fixture("textarea");
  try {
    assert.equal((await f.publish()).status, "verified");
    assert.equal(f.counts.submissions, 1);
  } finally {
    await f.clean();
  }
});
test("AI-origin topic selects the official AI declaration while a manual topic leaves it unchanged", async () => {
  for (const ai of [true, false]) {
    const f = await fixture("success", { ai, declaration: true });
    try {
      assert.equal((await f.publish()).status, "verified");
      assert.equal(f.submittedDeclaration, ai ? "贴子含AI内容" : "内容声明");
      assert.equal(f.counts.submissions, 1);
    } finally {
      await f.clean();
    }
  }
});
test("native local image upload binds hashes to official image URLs and verifies posted images", async () => {
  const f = await fixture("success", { images: true });
  try {
    const r = await f.publish();
    assert.equal(r.status, "verified");
    assert.deepEqual(r.images, [
      { sha256: f.p.images[0].sha256, url: f.urls[0] },
    ]);
    assert.deepEqual(f.counts, {
      submissions: 1,
      uploads: 1,
      checkpoints: 1,
      guards: 2,
    });
  } finally {
    await f.clean();
  }
});
test("occupied or ambiguous topic editor, wrong forum, captcha and external redirect do not mutate", async () => {
  for (const mode of [
    "occupied",
    "duplicate",
    "wrong-forum",
    "challenge",
    "redirect",
  ] as const) {
    const f = await fixture(mode);
    try {
      await assert.rejects(f.publish());
      assert.equal(f.counts.submissions, 0);
      assert.equal(f.counts.checkpoints, 0);
    } finally {
      await f.clean();
    }
  }
});
test("sequential native uploads bind each local hash to its unique new official image", async () => {
  const f = await fixture("success", { imageCount: 2 });
  try {
    const r = await f.publish();
    assert.equal(r.status, "verified");
    assert.deepEqual(
      r.images,
      f.p.images.map((i, n) => ({ sha256: i.sha256, url: f.urls[n] })),
    );
    assert.deepEqual(f.counts, {
      submissions: 1,
      uploads: 2,
      checkpoints: 1,
      guards: 3,
    });
  } finally {
    await f.clean();
  }
});
test("observed official toolbar opens local upload, selects free no-watermark, and captures the native chooser", async () => {
  const f = await fixture("success", { toolbar: true, imageCount: 2 });
  try {
    const r = await f.publish();
    assert.equal(r.status, "verified");
    assert.equal(f.counts.uploads, 2);
    assert.equal(f.counts.submissions, 1);
    assert.deepEqual(f.uploadPathCounts, {
      localOpens: 2,
      watermarkNext: 2,
      paidClicks: 0,
      networkClicks: 0,
    });
    assert.deepEqual(
      r.images,
      f.p.images.map((i, n) => ({ sha256: i.sha256, url: f.urls[n] })),
    );
  } finally {
    await f.clean();
  }
});
test("a different posted image cannot be verified from the local upload receipt", async () => {
  const f = await fixture("wrong-image", { images: true });
  try {
    const r = await f.publish();
    assert.equal(r.status, "uncertain");
    assert.equal(r.images[0].url, f.urls[0]);
    assert.equal(f.counts.submissions, 1);
  } finally {
    await f.clean();
  }
});
test("after upload UID change and final service-scope revocation leave unknown and never click", async () => {
  for (const mode of ["upload-change", "success"] as const) {
    const f = await fixture(mode, { images: true });
    try {
      f.guardFailure = mode === "success";
      const r = await f.publish();
      assert.equal(r.status, "uncertain");
      assert.equal(f.counts.uploads, 1);
      assert.equal(f.counts.submissions, 0);
      assert.equal(f.counts.checkpoints, 1);
    } finally {
      await f.clean();
    }
  }
});
test("submission timeout, wrong author, missing original body cannot become success", async () => {
  for (const mode of ["unknown", "wrong-author", "missing-body"] as const) {
    const f = await fixture(mode);
    try {
      const r = await f.publish();
      assert.equal(r.status, "uncertain");
      assert.equal(f.counts.submissions, 1);
      assert.equal(f.counts.checkpoints, 1);
    } finally {
      await f.clean();
    }
  }
});
test("explicit official moderation state stays pending review without fake topic receipt", async () => {
  const f = await fixture("review");
  try {
    const r = await f.publish();
    assert.equal(r.status, "pending_review");
    assert.equal(r.postId, null);
    assert.equal(f.counts.submissions, 1);
  } finally {
    await f.clean();
  }
});
test("unbound reconciliation includes own rows, requires fresh official first-post time, never writes", async () => {
  const submittedAt = new Date(Date.now() - 1000).toISOString();
  const f = await fixture("success", {
    own: true,
    createdAt: new Date().toISOString(),
  });
  try {
    const r = await f.adapter.reconcile(
      account,
      "111",
      f.p,
      submittedAt,
      topicUnknown(f.p, "断线"),
    );
    assert.equal(r.status, "verified");
    assert.equal(f.counts.submissions, 0);
    assert.equal(f.counts.uploads, 0);
  } finally {
    await f.clean();
  }
});
test("historical same-body own topic and missing timestamp cannot impersonate this submission", async () => {
  for (const createdAt of ["2020-01-01T00:00:00Z", ""]) {
    const f = await fixture("success", { own: true, createdAt });
    try {
      const r = await f.adapter.reconcile(
        account,
        "111",
        f.p,
        new Date().toISOString(),
        topicUnknown(f.p, "断线"),
      );
      assert.equal(r.status, "uncertain");
      assert.equal(r.threadId, null);
      assert.equal(f.counts.submissions, 0);
    } finally {
      await f.clean();
    }
  }
});
test("unbound reconciliation reads the real nested author marker and rejects conflicting authors", async () => {
  for (const conflict of [false, true]) {
    const f = await fixture("success", {
      own: true,
      nestedListAuthor: !conflict,
      conflictingListAuthor: conflict,
    });
    try {
      const result = await f.adapter.reconcile(
        account,
        "111",
        f.p,
        new Date(Date.now() - 1000).toISOString(),
        topicUnknown(f.p, "断线"),
      );
      assert.equal(result.status, conflict ? "uncertain" : "verified");
      assert.equal(f.counts.submissions, 0);
      assert.equal(f.counts.uploads, 0);
    } finally {
      await f.clean();
    }
  }
});
test("direct cloud anchors labelled 网页链接 prove the complete body while preserving original text", async () => {
  const f = await fixture("success", {
    own: true,
    nestedListAuthor: true,
    linkHref: "https://pan.baidu.com/s/1Fixture",
  });
  try {
    const page = await f.context.newPage();
    try {
      await page.goto("https://tieba.baidu.com/p/1000");
      const snapshot =
        await page.evaluate<TiebaTopicPageSnapshot>(tiebaTopicPageScript);
      assert.match(snapshot.topicPosts[0].text, /网页链接/);
      assert.match(
        snapshot.topicPosts[0].linkText!,
        /https:\/\/pan.baidu.com\/s\/1Fixture/,
      );
      assert.deepEqual(snapshot.topicPosts[0].replacedLinkHrefs, [
        "https://pan.baidu.com/s/1Fixture",
      ]);
    } finally {
      await page.close();
    }
    const result = await f.adapter.reconcile(
      account,
      "111",
      f.p,
      new Date(Date.now() - 1000).toISOString(),
      topicUnknown(f.p, "断线"),
    );
    assert.equal(result.status, "verified");
    assert.match(result.body!, /https:\/\/pan.baidu.com\/s\/1Fixture/);
    assert.equal(f.counts.submissions, 0);
  } finally {
    await f.clean();
  }
});
test("wrong share or redirect href cannot verify either generic labels or misleading literal URL text", async () => {
  for (const href of [
    "https://pan.baidu.com/s/1Wrong",
    "https://jump2.bdimg.com/safecheck/index?url=https%3A%2F%2Fpan.baidu.com%2Fs%2F1Fixture",
    "https://evil.invalid/s/1Fixture",
  ]) {
    for (const literalLinkLabel of [false, true]) {
      const f = await fixture("success", {
        own: true,
        nestedListAuthor: true,
        linkHref: href,
        literalLinkLabel,
      });
      try {
        const result = await f.adapter.reconcile(
          account,
          "111",
          f.p,
          new Date(Date.now() - 1000).toISOString(),
          topicUnknown(f.p, "断线"),
        );
        assert.equal(result.status, "uncertain");
        assert.equal(f.counts.submissions, 0);
        assert.equal(f.counts.uploads, 0);
      } finally {
        await f.clean();
      }
    }
  }
});
test("plain text cloud URL still proves its complete original body without inventing anchors", async () => {
  const f = await fixture("success", {
    own: true,
    nestedListAuthor: true,
    linkHref: "https://pan.baidu.com/s/1Fixture",
    plainLink: true,
  });
  try {
    const result = await f.adapter.reconcile(
      account,
      "111",
      f.p,
      new Date(Date.now() - 1000).toISOString(),
      topicUnknown(f.p, "断线"),
    );
    assert.equal(result.status, "verified");
    assert.equal(f.counts.submissions, 0);
  } finally {
    await f.clean();
  }
});
test("preflight existing own same-body topic stops a new publication before checkpoint", async () => {
  const f = await fixture("success", {
    own: true,
    createdAt: "2020-01-01T00:00:00Z",
  });
  try {
    await assert.rejects(f.publish(), /已有本人相同/);
    assert.equal(f.counts.submissions, 0);
    assert.equal(f.counts.checkpoints, 0);
  } finally {
    await f.clean();
  }
});
test("known exact topic ID can reconcile its retained original image bindings read-only", async () => {
  const f = await fixture("success", {
    images: true,
    createdAt: "2020-01-01T00:00:00Z",
  });
  try {
    const r = await f.adapter.reconcile(
      account,
      "111",
      f.p,
      new Date().toISOString(),
      topicUnknown(
        f.p,
        "已知官方TID",
        f.p.images.map((i, n) => ({ sha256: i.sha256, url: f.urls[n] })),
        "1000",
      ),
    );
    assert.equal(r.status, "verified");
    assert.equal(f.counts.submissions, 0);
  } finally {
    await f.clean();
  }
});
