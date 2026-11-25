import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createDecipheriv } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { devConnection } from "./dev-session-client.mjs";

/** Only attach to this task's newly opened account page. No existing-page inventory. */
export async function run({ page, checkpoint }) {
  const provider = process.env.PANXU_OFFICIAL_PROVIDER || "cmcc";
  const shareDraft = process.env.PANXU_CMCC_SHARE_DRAFT
    ? JSON.parse(await readFile(process.env.PANXU_CMCC_SHARE_DRAFT, "utf8"))
    : null;
  assert.ok(["cmcc", "xunlei"].includes(provider));
  const origin =
    provider === "cmcc" ? "https://yun.139.com/" : "https://pan.xunlei.com/";
  const accountId = await page.evaluate(async (provider) => {
    const rows = (await window.panxu.invoke("snapshot", {})).accounts.filter(
      (a) => a.provider === provider && a.enabled,
    );
    if (rows.length !== 1)
      throw Error("Expected exactly one selected drive account");
    return rows[0].id;
  }, provider);
  const connection = await devConnection();
  const version = await fetch(
    `http://127.0.0.1:${connection.cdpPort}/json/version`,
  ).then((r) => r.json());
  const socket = new WebSocket(version.webSocketDebuggerUrl),
    pending = new Map(),
    created = new Set();
  let serial = 0,
    observing = false,
    targetId,
    sessionId;
  const quotaRequests = [];
  const shareRequests = [],
    shareResponses = [],
    responseTasks = [];
  const decodeShare = (text) => {
    try {
      return JSON.parse(text);
    } catch {}
    const bytes = Buffer.from(text, "base64");
    for (const key of [
      "PVGDwmcvfs1uV3d1",
      "UqEZkrjCKfa02pP6jntzFmkzOz86zHUC",
    ]) {
      try {
        const decipher = createDecipheriv(
          key.length === 16 ? "aes-128-cbc" : "aes-256-cbc",
          Buffer.from(key),
          bytes.subarray(0, 16),
        );
        return JSON.parse(
          Buffer.concat([
            decipher.update(bytes.subarray(16)),
            decipher.final(),
          ]).toString(),
        );
      } catch {}
    }
    throw Error("Unknown official payload envelope");
  };
  let quotaHeaders, cmccHeaders;
  const send = (method, params = {}, session) =>
    new Promise((resolve, reject) => {
      const id = ++serial;
      pending.set(id, { resolve, reject });
      socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(session ? { sessionId: session } : {}),
        }),
      );
    });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id) {
      const p = pending.get(message.id);
      pending.delete(message.id);
      message.error
        ? p?.reject(Error(message.error.message))
        : p?.resolve(message.result);
      return;
    }
    if (!observing) return;
    if (
      shareDraft &&
      message.sessionId === sessionId &&
      message.method === "Network.requestWillBeSent"
    ) {
      const request = message.params.request,
        url = new URL(request.url);
      if (
        url.hostname.endsWith("yun.139.com") &&
        /outlink|share\/api|linkPlatform/i.test(url.pathname) &&
        !/report|advert/i.test(url.pathname)
      ) {
        if (request.method === "POST")
          cmccHeaders = Object.fromEntries(
            Object.entries(request.headers)
              .map(([key, value]) => [key.toLowerCase(), value])
              .filter(([key]) =>
                [
                  "authorization",
                  "mcloud-skey",
                  "mcloud-client",
                  "mcloud-version",
                  "x-yun-client-info",
                  "x-deviceinfo",
                  "user-agent",
                ].includes(key),
              ),
          );
        const sanitize = (value, depth = 0) => {
          if (depth > 6) return "[nested]";
          if (Array.isArray(value))
            return {
              count: value.length,
              sample: value.slice(0, 2).map((v) => sanitize(v, depth + 1)),
            };
          if (value && typeof value === "object")
            return Object.fromEntries(
              Object.entries(value).map(([key, val]) => [
                key,
                /token|cookie|sign|secret|pass|phone|account|owner|creator|url/i.test(
                  key,
                )
                  ? "[redacted]"
                  : sanitize(val, depth + 1),
              ]),
            );
          return typeof value === "string" ? value.slice(0, 120) : value;
        };
        let body;
        try {
          body = decodeShare(request.postData || "null");
        } catch {
          body = { format: "non-json", length: request.postData?.length };
        }
        shareRequests.push({
          requestId: message.params.requestId,
          path: url.pathname,
          method: request.method,
          headers: Object.fromEntries(
            Object.entries(request.headers).filter(([key]) =>
              /^(content-type|mcloud-client|mcloud-channel|mcloud-route|mcloud-version|mcloud-userid-flag|x-yun-api-version|x-yun-module-type|x-yun-channel-source)$/i.test(
                key,
              ),
            ),
          ),
          body: sanitize(body),
        });
      }
    }
    if (
      shareDraft &&
      message.sessionId === sessionId &&
      message.method === "Network.loadingFinished" &&
      shareRequests.some((r) => r.requestId === message.params.requestId)
    ) {
      const request = shareRequests.find(
        (r) => r.requestId === message.params.requestId,
      );
      const task = send(
        "Network.getResponseBody",
        { requestId: message.params.requestId },
        sessionId,
      )
        .then((result) => {
          let data;
          const raw = result.base64Encoded
            ? Buffer.from(result.body, "base64").toString()
            : result.body;
          try {
            data = decodeShare(raw);
          } catch {
            data = { format: "non-json", length: raw.length };
          }
          const scrub = (value, depth = 0) => {
            if (depth > 7) return "[nested]";
            if (Array.isArray(value))
              return {
                count: value.length,
                sample: value.slice(0, 2).map((v) => scrub(v, depth + 1)),
              };
            if (value && typeof value === "object")
              return Object.fromEntries(
                Object.entries(value).map(([key, val]) => [
                  key,
                  /token|cookie|sign|secret|pass|phone|account|owner|url/i.test(
                    key,
                  )
                    ? "[redacted]"
                    : scrub(val, depth + 1),
                ]),
              );
            return typeof value === "string" ? value.slice(0, 120) : value;
          };
          shareResponses.push({ path: request.path, data: scrub(data) });
        })
        .catch((error) =>
          shareResponses.push({ path: request.path, error: error.message }),
        );
      responseTasks.push(task);
    }
    if (
      message.sessionId === sessionId &&
      message.method === "Network.requestWillBeSent"
    ) {
      const request = message.params.request,
        url = new URL(request.url);
      if (
        url.hostname === "api-pan.xunlei.com" &&
        url.pathname === "/drive/v1/about"
      ) {
        if (request.method === "GET")
          quotaHeaders = Object.fromEntries(
            Object.entries(request.headers).filter(([key]) =>
              [
                "authorization",
                "x-client-id",
                "x-device-id",
                "x-captcha-token",
                "content-type",
              ].includes(key.toLowerCase()),
            ),
          );
        quotaRequests.push({
          method: request.method,
          path: url.pathname,
          query: Object.fromEntries(
            [...url.searchParams].map(([key, value]) => [
              key,
              ["space", "with", "with_quotas"].includes(key)
                ? value
                : "[omitted]",
            ]),
          ),
          headers: Object.keys(request.headers)
            .map((k) => k.toLowerCase())
            .sort(),
          clientVersion: Object.entries(request.headers).find(
            ([k]) => k.toLowerCase() === "x-client-version",
          )?.[1],
        });
      }
    }
    if (
      message.method === "Target.targetCreated" &&
      message.params.targetInfo.type === "page"
    )
      created.add(message.params.targetInfo.targetId);
    if (
      ["Target.targetCreated", "Target.targetInfoChanged"].includes(
        message.method,
      )
    ) {
      const info = message.params.targetInfo;
      if (created.has(info.targetId) && info.url.startsWith(origin))
        targetId = info.targetId;
    }
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  try {
    // Existing target events emitted when discovery starts are deliberately ignored.
    await send("Target.setDiscoverTargets", { discover: true });
    observing = true;
    if (shareDraft)
      await page.evaluate((input) => window.panxu.invoke("share.open", input), {
        accountId,
        sourceText: shareDraft.value.sourceText,
        code: shareDraft.value.code,
      });
    else
      await page.evaluate(
        (id) => window.panxu.invoke("account.login", { id }),
        accountId,
      );
    const deadline = Date.now() + 20000;
    while (!targetId && Date.now() < deadline) {
      await page.waitForTimeout(100);
      await checkpoint();
    }
    assert.ok(
      targetId,
      "No new task-owned account window; existing windows are left untouched.",
    );
    console.log(JSON.stringify({ provider, openedAccountTarget: targetId }));
    sessionId = (
      await send("Target.attachToTarget", { targetId, flatten: true })
    ).sessionId;
    if (shareDraft) {
      await send("Network.enable", {}, sessionId);
      const original = new URL(
        shareDraft.value.sourceText.match(/https?:\/\/[^\s<>"']+/)[0],
      );
      assert.equal(original.origin, "https://yun.139.com");
      await send("Page.navigate", { url: original.href }, sessionId);
      for (let i = 0; i < 8; i++) {
        await page.waitForTimeout(700);
        await checkpoint();
      }
      await send(
        "Runtime.evaluate",
        {
          expression:
            "(()=>{const vm=window.MCloudVM?.$route?.matched?.find(r=>r.instances.default?.$options.name==='outlink')?.instances.default;if(vm){vm.initLink();vm.initList();return true;}return false;})()",
          returnByValue: true,
        },
        sessionId,
      );
      await page.waitForTimeout(2200);
      await Promise.allSettled(responseTasks);
      const visible = await send(
        "Runtime.evaluate",
        {
          returnByValue: true,
          expression:
            "({text:document.body.innerText.slice(0,2500),route:window.MCloudVM?.$route?.name,scripts:Array.from(document.scripts).filter(s=>s.src).map(s=>new URL(s.src).pathname),components:window.MCloudVM?.$route?.matched?.map(r=>({name:r.instances.default?.$options.name,fields:Object.keys(r.instances.default?.$data||{}),methods:Object.keys(r.instances.default?.$options.methods||{})}))})",
        },
        sessionId,
      );
      if (
        process.env.PANXU_CMCC_INTAKE_TASK_READ !== "1" &&
        process.env.PANXU_CMCC_INTAKE_HISTORY_READ !== "1"
      )
        console.log(
          JSON.stringify({
            shareRequests,
            shareResponses,
            visible: visible.result?.value,
          }),
        );
      if (process.env.PANXU_CMCC_TEST_PROVIDER_SOURCE === "1") {
        assert.ok(
          cmccHeaders?.authorization?.startsWith("Basic "),
          "本轮官方分享请求未捕获本人会话",
        );
        const { CmccProvider } = await import("../core/providers/cmcc.ts");
        const fetchInAccount = async (id, url, init = {}) => {
          assert.equal(id, accountId);
          const headers = Object.fromEntries(
            Object.entries(init.headers ?? {}).map(([key, value]) => [
              key,
              /[^\x00-\xff]/.test(String(value))
                ? Buffer.from(String(value), "utf8").toString("latin1")
                : value,
            ]),
          );
          init = { ...init, headers };
          const response = await send(
            "Runtime.evaluate",
            {
              awaitPromise: true,
              returnByValue: true,
              expression: `(async()=>{const r=await fetch(${JSON.stringify(url)},${JSON.stringify(init)});return {status:r.status,text:await r.text()};})()`,
            },
            sessionId,
          );
          if (response.exceptionDetails)
            console.log(
              JSON.stringify({
                sourceTransportPath: new URL(url).pathname,
                exception: response.exceptionDetails.text,
              }),
            );
          if (response.result?.value?.status !== 200)
            console.log(
              JSON.stringify({
                sourceTransportPath: new URL(url).pathname,
                status: response.result?.value?.status,
              }),
            );
          assert.ok(!response.exceptionDetails, "本轮官方窗口传输失败");
          assert.equal(response.result.value.status, 200);
          return response.result.value.text;
        };
        const providerClient = new CmccProvider({
          authHeaders: async () => ({ ...cmccHeaders }),
          text: fetchInAccount,
          json: async (...args) => JSON.parse(await fetchInAccount(...args)),
        });
        const account = await page.evaluate(
          async (id) => window.panxu.invoke("account.capacity", { id }),
          accountId,
        );
        const phone = Buffer.from(cmccHeaders.authorization.slice(6), "base64")
          .toString()
          .split(":")[1];
        const { CmccShares } = await import("../core/providers/cmcc-share.ts");
        const historyRead = async (_account, _path, data) =>
          providerClient.request(
            account,
            "https://yun.139.com/orchestration/personalCloud-rebuild",
            "/outlink/v1.0/getOutLinkList",
            data,
          );
        const shareClient = new CmccShares(
          async () => ({ uid: account.uid, account: phone }),
          (account, path, data, write) =>
            providerClient.request(
              account,
              "https://share-kd-njs.yun.139.com/yun-share/richlifeApp/devapp",
              path,
              data,
              write,
              {
                "hcy-cool-flag": "1",
                "mcloud-client": "10702",
                "mcloud-version": "7.13.3",
                "x-yun-channel-source": "10213406",
                "x-huawei-channelSrc": "10213406",
                "x-yun-app-channel": "10213406",
              },
              "encrypted",
            ),
          historyRead,
        );
        if (process.env.PANXU_CMCC_INTAKE_HISTORY_READ === "1") {
          const result = await historyRead(account, "", {
            getOutLinkLstReq: {
              needSetAccount: true,
              srt: 1,
              srtDr: 0,
              bNum: 1,
              eNum: 100,
              qryType: 1,
              commonAccountInfo: { account: phone, accountType: 1 },
            },
          });
          await writeFile(
            "/private/tmp/panxu-cmcc-own-share-history.json",
            JSON.stringify(result),
            { mode: 0o600 },
          );
          const shape = (value, depth = 0) => {
            if (depth > 4) return "[nested]";
            if (Array.isArray(value))
              return {
                length: value.length,
                sample: value[0] ? shape(value[0], depth + 1) : null,
              };
            if (value && typeof value === "object")
              return Object.fromEntries(
                Object.entries(value).map(([k, v]) => [
                  k,
                  /count|num|total|invalid/i.test(k) && typeof v !== "object"
                    ? v
                    : shape(v, depth + 1),
                ]),
              );
            return value == null ? null : typeof value;
          };
          console.log(
            JSON.stringify({
              phase: "own-share-history",
              shape: shape(result),
              scope: "authenticated history only; no new share",
            }),
          );
          const ids = JSON.parse(
            await readFile(
              "/private/tmp/panxu-cmcc-intake-result.json",
              "utf8",
            ),
          );
          const resource = await page.evaluate(
            (id) => window.panxu.invoke("resource.get", { id }),
            ids.resourceId,
          );
          const copy = resource.copies.find((c) => c.id === ids.copyId);
          const recovered = await shareClient.find(account, copy.files);
          assert.ok(recovered, "本人分享的归属与文件未匹配");
          assert.equal(recovered.ownerUid, account.uid);
          await writeFile(
            "/private/tmp/panxu-cmcc-recovered-share.json",
            JSON.stringify(recovered),
            { mode: 0o600 },
          );
          console.log(
            JSON.stringify({
              phase: "existing-share-verified",
              title: resource.title,
              fileCount: copy.files.length,
              hasCode: !!recovered.code,
              expiresAt: recovered.expiresAt,
              scope:
                "existing share found and ownership/manifest verified; no creation",
            }),
          );
          return;
        }
        if (process.env.PANXU_CMCC_INTAKE_TASK_READ === "1") {
          const ids = JSON.parse(
            await readFile(
              "/private/tmp/panxu-cmcc-intake-result.json",
              "utf8",
            ),
          );
          const dataPath = await page.evaluate(
            async () => (await window.panxu.invoke("snapshot", {})).dataPath,
          );
          const db = new DatabaseSync(join(dataPath, "panxu.db"), {
            readOnly: true,
          });
          let metadata;
          try {
            metadata = JSON.parse(
              db
                .prepare("SELECT metadata FROM jobs WHERE id=? AND copy_id=?")
                .get(ids.jobId, ids.copyId).metadata,
            );
          } finally {
            db.close();
          }
          assert.ok(metadata.taskId);
          const result = await providerClient.request(
            account,
            "https://share-kd-njs.yun.139.com/yun-share/richlifeApp/devapp",
            "/IBatchOprTask/queryBatchOprTaskDetail",
            {
              queryBatchOprTaskDetailReq: {
                taskID: metadata.taskId,
                msisdn: phone,
                commonAccountInfo: { account: phone, accountType: 1 },
              },
            },
            false,
            {
              "hcy-cool-flag": "1",
              "mcloud-client": "10702",
              "mcloud-version": "7.13.3",
              "x-yun-channel-source": "10213406",
              "x-huawei-channelSrc": "10213406",
              "x-yun-app-channel": "10213406",
            },
            "encrypted",
          );
          const task =
            result.queryBatchOprTaskDetailRes?.batchOprTask ??
            result.batchOprTask;
          console.log(
            JSON.stringify({
              phase: "existing-transfer-task",
              keys: Object.keys(result),
              task: task
                ? {
                    taskStatus: task.taskStatus,
                    taskResultCode: task.taskResultCode,
                    resultCode: task.resultCode,
                    progress: task.progress,
                  }
                : null,
              sourcePoll: await shareClient.poll(account, metadata.taskId),
              scope: "read existing task only; no transfer/share creation",
            }),
          );
          return;
        }
        const root = await shareClient.inspect(account, shareDraft.source);
        const child = root.files[0]?.isDirectory
          ? await shareClient.inspect(
              account,
              shareDraft.source,
              root.files[0].id,
            )
          : null;
        console.log(
          JSON.stringify({
            newProviderSourceRead: {
              title: root.title,
              rootCount: root.files.length,
              childCount: child?.files.length,
              childHasMore: child?.hasMore,
              firstFile: child?.files[0]
                ? { name: child.files[0].name, size: child.files[0].size }
                : null,
            },
            scope:
              "real new provider source over only this task account page; not loaded backend acceptance",
          }),
        );
      }
      return;
    }
    let ready = false;
    while (!ready && Date.now() < deadline) {
      ready = (
        await send(
          "Runtime.evaluate",
          {
            expression:
              provider === "cmcc"
                ? "!!window.MCloudVM?.$store"
                : "!!window.$nuxt?.$store",
            returnByValue: true,
          },
          sessionId,
        ).catch(() => ({ result: { value: false } }))
      ).result.value;
      if (!ready) await page.waitForTimeout(200);
    }
    assert.ok(ready, "Official account page did not finish loading");
    if (provider === "xunlei") await send("Network.enable", {}, sessionId);
    await page.waitForTimeout(800);
    const result = await send(
      "Runtime.evaluate",
      {
        awaitPromise: true,
        returnByValue: true,
        expression:
          provider === "cmcc"
            ? `(async()=>{
      const r=await window.MCloudVM.$store.dispatch('queryUserBenefits');
      const summarize=row=>({fields:Object.keys(row),...Object.fromEntries(Object.entries(row).filter(([key,value])=>/(Time|Date|expir|valid|memberLevel|memberLvName|prodName)/i.test(key)&&['number','string'].includes(typeof value)).map(([key,value])=>[key,String(value).slice(0,80)])),...(Array.isArray(row.chargingPolicyList)?{chargingPolicyList:row.chargingPolicyList.map(summarize)}:{})});
      return {success:r?.success,members:r?.data?.userSubMemberList?.map(summarize)};
    })()`
            : `(async()=>{
      const store=window.$nuxt.$store;
      const actions=Object.keys(store._actions).filter(key=>/(^|\\/)getAbout$/.test(key));
      if(actions.length!==1)return {actions};
      try {
        await store.dispatch(actions[0],{space:''});
        const quotas=[];
        const read=(object,path='',depth=0)=>{if(!object||typeof object!=='object'||depth>4)return;if(object.usage!=null&&object.limit!=null)quotas.push({path,usage:String(object.usage),limit:String(object.limit)});for(const[key,value]of Object.entries(object))if(!/auth|token|cookie|account|user|password/i.test(key))read(value,path+'.'+key,depth+1);};
        read(store.state);
        return {ok:true,quotas};
      }catch(error){return {ok:false,code:error.error_code,error:error.error,description:String(error.error_description||error.message||'').replace(/Bearer\\s+\\S+/gi,'Bearer [redacted]').slice(0,200)};}
    })()`,
      },
      sessionId,
    );
    assert.ok(
      !result.exceptionDetails,
      "Official read-only membership query failed",
    );
    console.log(
      JSON.stringify({ targetId, ...result.result.value, quotaRequests }),
    );
    if (
      provider === "xunlei" &&
      quotaHeaders &&
      process.env.PANXU_THUNDER_COMPARE_SCOPE === "1"
    ) {
      const compared = await send(
        "Runtime.evaluate",
        {
          awaitPromise: true,
          returnByValue: true,
          expression: `(async()=>{
        const headers=${JSON.stringify(quotaHeaders)}, outcomes=[];
        for(const path of ['/drive/v1/about?space=','/drive/v1/files?space=&parent_id=&limit=1']) {
          const response=await fetch('https://api-pan.xunlei.com'+path,{headers,credentials:'include'}),data=await response.json();
          outcomes.push({path,status:response.status,code:data.error_code,error:data.error,description:String(data.error_description||'').slice(0,120),files:data.files?.length,quota:data.quota?{usage:data.quota.usage,limit:data.quota.limit}:null});
        }
        return outcomes;
      })()`,
        },
        sessionId,
      );
      console.log(JSON.stringify({ scopeComparison: compared.result.value }));
      const toolResult = await page.evaluate(async (id) => {
        const a = await window.panxu.invoke("account.capacity", { id });
        return { status: a.status, capacity: a.capacity };
      }, accountId);
      console.log(JSON.stringify({ toolImmediatelyAfterOfficial: toolResult }));
    }
    if (
      provider === "xunlei" &&
      quotaHeaders &&
      process.env.PANXU_THUNDER_COMPARE_CAPTCHA === "1"
    ) {
      const compared = await send(
        "Runtime.evaluate",
        {
          awaitPromise: true,
          returnByValue: true,
          expression: `(async()=>{
        const full=${JSON.stringify(quotaHeaders)}, outcomes=[];
        for(const keepCaptcha of [true,false]) {
          const headers=Object.fromEntries(Object.entries(full).filter(([key])=>keepCaptcha||key.toLowerCase()!=='x-captcha-token'));
          const response=await fetch('https://api-pan.xunlei.com/drive/v1/about?space=',{headers,credentials:'include'});
          const data=await response.json();
          outcomes.push({keepCaptcha,status:response.status,code:data.error_code,error:data.error,description:String(data.error_description||'').slice(0,120),quota:data.quota?{usage:data.quota.usage,limit:data.quota.limit}:null});
        }
        return outcomes;
      })()`,
        },
        sessionId,
      );
      console.log(JSON.stringify({ comparison: compared.result.value }));
    }
  } finally {
    observing = false;
    if (targetId && created.has(targetId))
      await send("Target.closeTarget", { targetId }).catch(() => {});
    socket.close();
  }
}
