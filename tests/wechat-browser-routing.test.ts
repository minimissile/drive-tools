import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers";
import { defaultOtherAccountBrowser } from "../src/accounts/useOtherAccounts";
import type { WechatDraftPayload } from "../shared/wechat";
import type { BrowserContext } from "playwright-core";
import { createBrowserPlatformPorts } from "../core/browser-platform-ports";
import { WebsiteAccounts } from "../core/website-accounts";

test("网盘与公众号共用时身份域分离，环境租约仍阻止并发操作", async () => {
  const f=await fixture();
  f.app.environments.setExternalConfigurationReader(async()=>({signature:"stable",proxy:"configured",stopWhileNetError:true}));
  let release!:()=>void;
  try {
    const env=await f.app.environments.save({name:"共用配置",engine:"bitbrowser",profileId:"shared-profile"});
    const drive=await f.app.invoke("account.add",{provider:"baidu",alias:"网盘"}) as {id:string};
    const driveRef={kind:"drive" as const,id:drive.id};
    f.app.environments.registerAccount(driveRef,env.id);
    const wechat=f.app.websiteAccounts.add("wechat","公众号",env.id);
    const ref={kind:"website" as const,id:wechat.id};
    assert.notEqual(f.app.environments.link(ref).identityId,f.app.environments.link(driveRef).identityId);
    const gate=new Promise<void>(r=>{release=r;});
    let start!:()=>void;
    const started=new Promise<void>(r=>{start=r;});
    const active=f.app.environments.run(driveRef,async()=>{start();await gate;});
    await started;
    try { await assert.rejects(f.app.environments.run(ref,async()=>{}),{code:"ENVIRONMENT_BUSY"}); }
    finally {release();await active;}
  } finally {release?.();await f.cleanup();}
});

test("公众号默认指纹，可创建或迁移至比特，内置账号保留原方式，允许与网盘共用并保持其他平台限制", async () => {
  const f = await fixture();
  f.app.environments.setExternalIdleGuard(async () => {});
  try {
    assert.equal(defaultOtherAccountBrowser("wechat").fingerprint, true);
    assert.equal(defaultOtherAccountBrowser("smzdm").fingerprint, false);
    const env = await f.app.environments.save({
      name: "公众号配置",
      engine: "bitbrowser",
      profileId: "wechat-route",
    });
    const account = f.app.websiteAccounts.add("wechat", "指纹公众号", env.id);
    assert.equal(
      f.app.environments.forAccount({ kind: "website", id: account.id }).id,
      env.id,
    );
    const native = f.app.websiteAccounts.add("wechat", "原内置公众号");
    assert.equal(
      f.app.environments.forAccount({ kind: "website", id: native.id }).engine,
      "electron",
    );
    const target = await f.app.environments.save({
      name: "迁移目标",
      engine: "bitbrowser",
      profileId: "wechat-migrate",
    });
    await f.app.environments.bind(
      { kind: "website", id: native.id },
      target.id,
    );
    assert.equal(
      f.app.environments.forAccount({ kind: "website", id: native.id }).id,
      target.id,
    );
    const drive = (await f.app.invoke("account.add", {
      provider: "baidu",
      alias: "百度",
    })) as { id: string };
    const driveEnv = await f.app.environments.save({name:"网盘共用",engine:"bitbrowser",profileId:"drive-common"});
    f.app.environments.registerAccount({kind:"drive",id:drive.id}, driveEnv.id);
    const shared = f.app.websiteAccounts.add(
      "wechat",
      "网盘共用公众号",
      driveEnv.id,
    );
    assert.equal(
      f.app.environments.forAccount({ kind: "website", id: shared.id }).id,
      driveEnv.id,
    );
    assert.throws(
      () => f.app.websiteAccounts.add("weibo", "仍不允许", driveEnv.id),
      { code: "DRIVE_PROFILE_EXCLUSIVE" },
    );
  } finally {
    await f.cleanup();
  }
});

test("公众号身份、上传草稿、打开均路由至选定比特；失败不回退内置，原内置方式可用", async () => {
  const f = await fixture();
  f.app.environments.setExternalConfigurationReader(async () => ({
    signature: "stable",
    proxy: "configured",
    stopWhileNetError: true,
  }));
  const events: string[] = [];
  const context = {} as BrowserContext;
  const receipt = {
    draftId: "10001",
    url: "https://mp.weixin.qq.com/cgi-bin/appmsg?appmsgid=10001",
  };
  let fail = false;
  try {
    // The platform ports retain this instance's native ports; inject only the business transport.
    f.ports.wechat = {
      readArticle: async () => {
        throw Error("unused");
      },
      saveDraft: async () => {
        events.push("native-save");
        return receipt;
      },
      open: async () => {
        events.push("native-open");
      },
    };
    f.ports.wechatBrowserSession = (selected, account) => {
      assert.equal(selected, context);
      return {
        verify: async () => {
          events.push("bit-verify");
          if (fail) throw Error("比特断开");
          return {
            hasSession: true,
            uid: "gh_route123",
            nickname: "公众号",
            windowOpen: false,
            error: null,
          };
        },
        port: {
          readArticle: f.ports.wechat!.readArticle,
          saveDraft: async (a, payload, beforeSubmit, onReceipt) => {
            assert.equal(a.id, account.id);
            assert.equal(payload.uid, a.uid);
            events.push("bit-upload-save");
            await beforeSubmit();
            await onReceipt?.({
              ...receipt,
              title: payload.title,
              html: payload.html,
              coverUrl: payload.coverUrl!,
            });
            return receipt;
          },
          open: async () => {
            events.push("bit-open");
          },
        },
      };
    };
    f.app.bit.withProfile = async (_profile, action) => {
      events.push(`profile:${_profile}`);
      return action(context);
    };
    const ports = createBrowserPlatformPorts(
      f.ports,
      f.app.environments,
      () => f.app.bit,
    );
    const accounts = new WebsiteAccounts(
      f.app.db,
      ports,
      () => {},
      f.app.environments,
    );
    const env = await f.app.environments.save({
      name: "公众号",
      engine: "bitbrowser",
      profileId: "wechat-selected",
    });
    const account = f.app.websiteAccounts.add("wechat", "公众号", env.id);
    const verified = await accounts.verify(account.id);
    assert.equal(verified.uid, "gh_route123");
    const payload = {
      uid: verified.uid,
      title: "素材说明",
      html: "<p>正文</p>",
      author: "",
      digest: "",
      coverUrl: "panxu-media://wechat/local.png",
    } as WechatDraftPayload;
    const port = ports.wechat!;
    await f.app.environments.run({ kind: "website", id: account.id }, () =>
      port.saveDraft(verified, payload, async () => {
        events.push("before-submit");
      }),
    );
    await f.app.environments.run({ kind: "website", id: account.id }, () =>
      port.open(verified),
    );
    assert.ok(events.includes("bit-upload-save"));
    assert.ok(events.includes("before-submit"));
    assert.ok(events.includes("bit-open"));
    assert.ok(!events.includes("native-save"));
    fail = true;
    await assert.rejects(accounts.verify(account.id), /比特断开/);
    assert.ok(!events.includes("native-save"));
    assert.equal(f.app.websiteAccounts.get(account.id).uid, "gh_route123");
    const native = f.app.websiteAccounts.add("wechat", "内置公众号");
    await port.open(native);
    await port.saveDraft(native, payload, async () => {});
    assert.ok(events.includes("native-open"));
    assert.ok(events.includes("native-save"));
  } finally {
    await f.cleanup();
  }
});
