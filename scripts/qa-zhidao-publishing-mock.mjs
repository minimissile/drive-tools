// Renderer-only fixture. All remote writes and keyword requests stay inside this test page.
const storageKey = "zhidao-publishing-qa";
const state = () =>
  JSON.parse(sessionStorage.getItem(storageKey) || '{"records":{},"calls":[]}');
const save = (value) =>
  sessionStorage.setItem(storageKey, JSON.stringify(value));
export const library = {
  id: "qa-office",
  title: "办公表格练习",
  provider: "baidu",
  sourceUrl: "https://pan.baidu.com/s/office",
  category: "效率办公",
  summary: "包含表格整理和月报核对练习，适用于熟悉基础公式的读者。",
  searchKeywords: ["办公表格练习", "月报整理材料"],
  copies: [
    {
      id: "qa-copy",
      accountId: "qa-drive",
      status: "ready",
      verifiedAt: "2026-11-19",
      ownerUid: "qa",
      files: [{ id: "file" }],
      shareUrl: "https://pan.baidu.com/s/canonical",
      shareVerifiedAt: "2026-11-19",
    },
  ],
};
export async function publishingMock(method, args) {
  const current = state();
  if (method === "snapshot")
    return window.panxu.invoke(method, args).then((snapshot) => ({
      ...snapshot,
      dataPath: snapshot.dataPath + "/publishing-qa",
      accounts: [
        {
          id: "qa-drive",
          alias: "百度资料账号",
          provider: "baidu",
          enabled: true,
          status: "connected",
          uid: "qa",
          defaultDirectory: "/盘序资料",
        },
      ],
      resources: [],
      jobs: [],
      drafts: [],
      bindings: [],
      publications: [],
    }));
  const publishers = [
    {
      id: "qa-publisher",
      alias: "主账号",
      nickname: "资料答主",
      status: "connected",
      bulkPermission: true,
      publishingRights: {
        hasPermission: true,
        isBanned: false,
        remainingQuota: 5000,
      },
    },
    {
      id: "qa-publisher-2",
      alias: "备用账号",
      nickname: "学习答主",
      status: "connected",
      bulkPermission: true,
      publishingRights: {
        hasPermission: true,
        isBanned: false,
        remainingQuota: 5000,
      },
    },
  ];
  if (method === "zhidao.accounts") return publishers;
  if (method === "zhidao.account.check") {
    current.calls.push({ method, args });
    save(current);
    return publishers.find((a) => a.id === args.id);
  }
  if (method === "zhidao.workflow.publish") {
    current.calls.push({ method, args });
    if (!args.authorized || !publishers.some((a) => a.id === args.accountId))
      throw new Error("请选择并确认发布账号");
    if (current.uploadRun) {
      save(current);
      return current.uploadRun;
    }
    const rows = args.ids.flatMap((id) => current.records[id].rows);
    if (rows.some((row) => !row.reviewed)) throw new Error("请先确认问答");
    const run = {
      id: crypto.randomUUID(),
      kind: "publish",
      title: args.taskName,
      status: "completed",
      total: rows.length,
      done: rows.length,
      message: "问答已上传，等待平台审核。",
      config: {
        workflowLinkType: args.linkType || "drive",
        workflowLinkUrl:
          args.linkType === "landing"
            ? "https://panxu.site/r/qa-office"
            : args.linkType === "redirect"
              ? "https://panxu.site/go/qa-office"
              : undefined,
        workflowLinkRevision: args.linkRevision,
        accountId: args.accountId,
        taskName: args.taskName,
        workflowIds: args.ids,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    current.uploadRun = run;
    args.ids.forEach((id) => (current.records[id].publicationRunId = run.id));
    save(current);
    return run;
  }
  if (method === "zhidao.workflow.linkOptions") {
    if (args.ids.flatMap((id) => current.records[id].rows).length !== 1)
      throw new Error("仅单个问答可选择公共入口");
    return {
      landingUrl: current.publicUnavailable
        ? null
        : "https://panxu.site/r/qa-office",
      redirectUrl: current.publicUnavailable
        ? null
        : "https://panxu.site/go/qa-office",
      landingIssue: current.publicUnavailable
        ? "固定入口尚未同步完成，请先在资源库完成同步。"
        : null,
      redirectIssue: current.publicUnavailable
        ? "固定入口尚未同步完成，请先在资源库完成同步。"
        : null,
      revision: "qa-public-v1",
    };
  }
  if (method === "zhidao.run" && current.uploadRun?.id === args.id)
    return {
      run: current.uploadRun,
      items: [],
      total: current.uploadRun.total,
      page: 1,
      pageSize: 25,
    };
  if (method === "zhidao.publish.sync") {
    current.calls.push({ method, args });
    current.uploadRun.config.platformTasks = [
      {
        id: "qa-platform-task",
        taskName: current.uploadRun.title,
        status: "finished",
        successCount: current.uploadRun.total,
        failCount: 0,
        usedQuota: current.uploadRun.total,
        checkedAt: new Date().toISOString(),
      },
    ];
    save(current);
    return current.uploadRun;
  }
  if (method === "zhidao.workflow.resources") return Promise.resolve([library]);
  if (method === "resource.intakeOptions")
    return Promise.resolve({
      categories: ["效率办公", "学习资料"],
      directories: ["/盘序资料"],
    });
  if (method === "websiteAccounts.list") return Promise.resolve([]);
  if (method === "resource.keywordBatch") {
    current.calls.push({ method, args });
    current.keywordBatch = {
      id: args.id,
      status: "running",
      items: args.items.map((item, index) => ({
        ...item,
        status: index === 0 ? "completed" : "running",
        ...(index === 0
          ? {
              result: {
                candidates: [
                  {
                    word: item.seeds[0] + "流量词",
                    sources: ["suggest"],
                    seeds: item.seeds,
                  },
                ],
                issues: [],
              },
            }
          : {}),
      })),
    };
    save(current);
    return Promise.resolve(current.keywordBatch);
  }
  if (method === "resource.keywordBatchStatus") {
    if (window.__keywordBatchFinish && current.keywordBatch) {
      current.keywordBatch.status = "completed";
      current.keywordBatch.items = current.keywordBatch.items.map((item) => ({
        ...item,
        status: "completed",
        result: item.result || {
          candidates: [
            {
              word: item.seeds[0] + "流量词",
              sources: ["5118"],
              seeds: item.seeds,
            },
          ],
          issues: [],
        },
      }));
      save(current);
    }
    return Promise.resolve(
      current.keywordBatch?.id === args.id ? current.keywordBatch : null,
    );
  }
  if (method === "resource.keywordLookup") {
    current.calls.push({ method, args });
    save(current);
    return Promise.resolve({
      candidates: [
        { word: "预算整理清单", sources: ["suggest"], seeds: args.seeds },
        { word: "预算表格练习", sources: ["5118"], seeds: args.seeds },
      ],
      issues: [],
    });
  }
  if (method === "zhidao.workflow.get") {
    if (window.__publishingTransferComplete)
      for (const record of Object.values(current.records))
        if (record.stage === "transferring") {
          record.stage = "sharing";
          record.message = "转存已完成";
        }
    save(current);
    return Promise.resolve(
      args.ids.map((id) => current.records[id]).filter(Boolean),
    );
  }
  if (method === "zhidao.workflow.planMany") {
    current.calls.push({ method, args });
    const records = args.resources.map(
      (resource) =>
        (current.records[resource.key] ??= {
          id: resource.key,
          resource,
          contentFirst: true,
          rowShares: {},
          copyId: "",
          libraryResourceId: resource.resourceId,
          accountId: "",
          stage: "draft",
          message: "等待生成并检查问答",
          operations: [],
          links: [],
          rows: [],
          updatedAt: new Date().toISOString(),
        }),
    );
    save(current);
    return records;
  }
  if (method === "zhidao.workflow.prepare") {
    current.calls.push({ method, args });
    const resource = args.resource;
    if (window.__publishingFailResource === resource.title) {
      save(current);
      return Promise.reject(new Error("此资源暂不可用，请核对原分享。"));
    }
    if (current.records[resource.key]?.copyId) {
      save(current);
      return Promise.resolve(current.records[resource.key]);
    }
    if (
      !current.records[resource.key]?.rows.every((row) => row.reviewed) ||
      !current.records[resource.key]?.rows.length
    )
      throw new Error("需先确认问答");
    current.records[resource.key] = {
      ...current.records[resource.key],
      id: resource.key,
      resource,
      copyId: resource.copyId || "qa-external-copy",
      libraryResourceId: resource.resourceId || "qa-external",
      accountId: args.accountId || "qa-drive",
      stage: resource.resourceId ? "sharing" : "transferring",
      message: resource.resourceId ? "已复用库中资源" : "转存进行中",
      operations: [],
      links: [],
      rows: current.records[resource.key].rows,
      updatedAt: new Date().toISOString(),
    };
    if (window.__publishingFailedTransfer === resource.title) {
      Object.assign(current.records[resource.key], {
        stage: "failed",
        message: "转存失败：fetch failed",
        transferBlocked: true,
        transferRecovery: { jobId: "qa-original-transfer", stage: "failed" },
      });
    }
    save(current);
    return Promise.resolve(current.records[resource.key]);
  }
  if (method === "job.retry") {
    const record = Object.values(current.records).find(
      (item) => item.transferRecovery?.jobId === args.id,
    );
    if (!record?.transferBlocked) throw new Error("仅能恢复原有失败转存任务");
    current.calls.push({ method, args });
    record.stage = "transferring";
    record.message = "原转存任务已恢复";
    delete record.transferBlocked;
    delete record.transferRecovery;
    save(current);
    return Promise.resolve(true);
  }
  if (method === "zhidao.workflow.shares") {
    current.calls.push({ method, args });
    const record = current.records[args.id];
    if (!record || record.transferBlocked || record.stage === "transferring")
      throw new Error("转存完成后才能创建分享");
    if (window.__publishingShareCheckUnavailable) {
      record.stage = "failed";
      record.shareCheck = {
        copyId: record.copyId,
        status: "unavailable",
        checkedAt: new Date().toISOString(),
        message: "无法连接比特浏览器本地服务。",
      };
      record.message =
        "分享检查暂未完成：无法连接比特浏览器本地服务。可在此重新检查并继续，已有资源与分享进度保留。";
      save(current);
      return Promise.reject(new Error(record.message));
    }
    if (window.__publishingHoldShares) {
      record.links = [
        { url: "https://pan.baidu.com/s/canonical", code: "abcd" },
      ];
      record.rowShares[record.rows[0].id] = record.links[0];
      record.stage = "sharing";
      record.message = "正在创建第2条分享";
      save(current);
      return new Promise((resolve) => {
        window.__publishingReleaseShares = () =>
          resolve(state().records[args.id]);
      });
    }
    const missingLinks = record.rows.slice(record.links.length);
    record.links.push(
      ...missingLinks.map((_, i) => ({
        url: `https://pan.baidu.com/s/share-${args.id}-${record.links.length + i}`,
        code: "abcd",
      })),
    );
    record.rows.forEach(
      (row, index) => (record.rowShares[row.id] ??= record.links[index]),
    );
    record.stage = "ready";
    record.message = "分享已准备";
    save(current);
    return Promise.resolve(record);
  }
  if (method === "zhidao.workflow.pause") {
    current.calls.push({ method, args });
    const record = current.records[args.id];
    if (record) {
      record.stage = "paused";
      record.message = "已暂停，已完成的分享保留";
    }
    save(current);
    window.__publishingHoldShares = false;
    window.__publishingReleaseShares?.();
    return Promise.resolve(true);
  }
  if (
    method === "zhidao.workflow.generate" ||
    method === "zhidao.workflow.generateMany"
  ) {
    current.calls.push({ method, args });
    const records = (args.ids || [args.id]).map((id) => current.records[id]);
    if (records.some((record) => !record?.contentFirst))
      throw new Error("需先规划资源");
    for (const record of records)
      if (
        !record.rows.length ||
        args.optimize ||
        record.generation?.status === "failed"
      ) {
        const targets = record.resource.keywords
          .slice(0, 20)
          .flatMap((_, index) => (record.rows[index]?.reviewed ? [] : [index]));
        record.generation = {
          id: crypto.randomUUID(),
          status: "running",
          targets,
          drafts: [],
        };
        save(current);
        if (window.__publishingGenerationFail) {
          record.generation.status = "failed";
          record.generation.message =
            "模型连接中断，本次结果与费用待核对；已完成批次保留。";
          save(current);
          throw new Error(record.generation.message);
        }
        if (window.__publishingHoldGeneration)
          await new Promise((resolve) => {
            window.__publishingReleaseGeneration = resolve;
          });
        record.rows = record.resource.keywords.slice(0, 20).map((keyword, i) =>
          record.rows[i]?.reviewed
            ? record.rows[i]
            : {
                id: record.rows[i]?.id || crypto.randomUUID(),
                relatedKeywords: [],
                keyword,
                question: `${keyword}的百度网盘${args.optimize ? "分享地址在哪" : "链接在哪"}？`,
                answer: `<p>${record.resource.summary}${args.optimize ? "围绕" : "关于"}「${keyword}」，可核对已有资料中的相应练习内容。</p>`,
                reviewed: false,
              },
        );
        record.generation.status = "completed";
        save(current);
      }
    save(current);
    return Promise.resolve(
      method === "zhidao.workflow.generateMany" ? records : records[0],
    );
  }
  if (method === "zhidao.workflow.saveRows") {
    current.calls.push({ method, args });
    current.records[args.id].rows = args.rows;
    save(current);
    return Promise.resolve(current.records[args.id]);
  }
  if (method === "zhidao.workflow.export") {
    current.calls.push({ method, args });
    save(current);
    return Promise.resolve("/tmp/百度知道问答.xlsx");
  }
  if (
    /^(?:share\.|resource\.save|zhidao\.(?:start|publish\.|account\.)|zhidao\.workflow\.|job\.|account\.login)/.test(
      method,
    )
  )
    throw new Error(`测试禁止真实写入：${method}`);
  return window.panxu.invoke(method, args);
}
