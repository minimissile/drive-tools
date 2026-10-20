import { useEffect, useState } from "react";
import { z } from "zod";
import { useAppActions, useAppData, useAppNavigation } from "../state";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { useIpcQuery } from "../api/useIpcQuery";
import { Button, Field, Notice, Panel } from "../ui/primitives";
import { Select } from "../ui/Select";
import { QueryError } from "../ui/QueryError";
import { updateSelection } from "../lib/selection";
import { OperationsWorkspace } from "./Workspace";
import { useOperation, useOperationAction } from "./hooks";
import { RunPanel } from "./RunPanel";
import { ResultTable } from "./Results";
const form = z.object({
  mode: z.enum(["precise", "fuzzy"]),
  keywords: z.string(),
  count: z.number(),
  zhidao: z.boolean(),
  pansou: z.boolean(),
  accountIds: z.array(z.string()),
  directory: z.string(),
  targetAccount: z.string(),
});
export default function Collection() {
  const { data } = useAppData(),
    { navigate } = useAppNavigation(),
    { refresh, notify } = useAppActions();
  const model = useOperation("collect"),
    action = useOperationAction();
  const [selected, setSelected] = useState<string[]>([]),
    [rights, setRights] = useState(false),
    [url, setUrl] = useState<string | null>(null);
  const [handoff] = useState(() => {
    try {
      const key = `panxu-collect-handoff:${data!.dataPath}`,
        value = JSON.parse(localStorage.getItem(key) ?? "[]");
      return z.array(z.string()).parse(value).join("\n");
    } catch {
      return "";
    }
  });
  useEffect(() => {
    localStorage.removeItem(`panxu-collect-handoff:${data!.dataPath}`);
  }, [data!.dataPath]);
  const draft = useLocalDraft(
    `panxu-collection:${data!.dataPath}`,
    {
      mode: "precise" as const,
      keywords: handoff,
      count: 100,
      zhidao: true,
      pansou: true,
      accountIds: [] as string[],
      directory: "/盘序采集",
      targetAccount: "",
    },
    (raw) => {
      const parsed = form.parse(raw);
      return handoff ? { ...parsed, keywords: handoff } : parsed;
    },
  );
  useEffect(() => {
    setSelected([]);
    setRights(false);
  }, [model.id]);
  const accounts = useIpcQuery("zhidao.accounts", undefined, {}),
    settings = useIpcQuery("zhidao.settings", undefined, {});
  const words = [
    ...new Set(
      draft.value.keywords
        .split(/\r?\n/)
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  ];
  return (
    <OperationsWorkspace
      title="资源采集"
      description="百度知道与本地 PanSou 搜索资源，保留来源、提取码和备选链接，再交给现有转存流程。"
    >
      <Panel title="新建采集任务">
        <div className="operations-form-grid">
          <Field label="采集方式">
            <Select
              value={draft.value.mode}
              onValueChange={(mode) =>
                draft.update({ mode: mode as "precise" | "fuzzy" })
              }
              items={[
                { value: "precise", label: "精准采集 · 每词最多一条" },
                { value: "fuzzy", label: "模糊采集 · 按领域翻页" },
              ]}
            />
          </Field>
          <Field label="目标条数" hint="1–500条">
            <input
              type="number"
              min={1}
              max={500}
              value={draft.value.count}
              onChange={(e) => draft.update({ count: Number(e.target.value) })}
            />
          </Field>
        </div>
        <Field
          label={draft.value.mode === "precise" ? "关键词列表" : "领域关键词"}
          hint="每行一个，最多500个"
        >
          <textarea
            rows={5}
            value={draft.value.keywords}
            onChange={(e) => draft.update({ keywords: e.target.value })}
            placeholder="例如：Excel 财务模板\nPython 入门练习"
          />
        </Field>
        <div className="operations-actions">
          <Button
            disabled={!!action.pending}
            onClick={() =>
              void action.run("zhidao.import", { kind: "keywords" }, (file) => {
                if (file)
                  draft.update({
                    keywords: [
                      ...new Set([...words, ...file.rows.map((r) => r[0])]),
                    ].join("\n"),
                  });
              })
            }
          >
            导入 TXT / CSV / XLSX
          </Button>
          <Button
            disabled={!!action.pending}
            onClick={() =>
              void action.run(
                "zhidao.import",
                { kind: "resources" },
                (file) => {
                  if (file)
                    void action.run(
                      "zhidao.import.resources",
                      { rows: file.rows, authorized: true },
                      model.pick,
                      "资源表已导入",
                    );
                },
              )
            }
          >
            导入资源表
          </Button>
          <span>{words.length}个有效关键词</span>
        </div>
        <div className="operations-source-picks">
          <label className="check">
            <input
              type="checkbox"
              checked={draft.value.zhidao}
              onChange={(e) => draft.update({ zhidao: e.target.checked })}
            />
            百度知道
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={draft.value.pansou}
              onChange={(e) => draft.update({ pansou: e.target.checked })}
            />
            PanSou 本地搜索与验活
          </label>
        </div>
        {draft.value.zhidao ? (
          <>
            <QueryError
              error={accounts.error}
              loading={accounts.loading}
              onRetry={accounts.reload}
            />
            <div className="operations-account-picks">
              <strong>采集账号（最多2个）</strong>
              {accounts.data?.length ? (
                accounts.data.map((a) => (
                  <label className="check" key={a.id}>
                    <input
                      type="checkbox"
                      checked={draft.value.accountIds.includes(a.id)}
                      disabled={a.status !== "connected"}
                      onChange={(e) =>
                        draft.update({
                          accountIds: updateSelection(
                            draft.value.accountIds,
                            [a.id],
                            e.target.checked,
                            2,
                          ),
                        })
                      }
                    />
                    {a.alias}
                    {a.status !== "connected" ? " · 需要登录检查" : ""}
                  </label>
                ))
              ) : (
                <Button quiet onClick={() => navigate("zhidao-accounts")}>
                  配置知道账号
                </Button>
              )}
            </div>
          </>
        ) : null}
        <details className="operations-settings">
          <summary>PanSou 连接设置</summary>
          <QueryError
            error={settings.error}
            loading={settings.loading}
            onRetry={settings.reload}
          />
          {settings.data ? (
            <>
              <Field label="本机服务地址" hint="留空使用随盘序提供的服务">
                <input
                  value={url ?? settings.data.pansouUrl}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="http://127.0.0.1:8888"
                />
              </Field>
              <Button
                disabled={!!action.pending}
                onClick={() =>
                  void action.run(
                    "zhidao.settings.save",
                    { pansouUrl: url ?? settings.data!.pansouUrl },
                    () => settings.reload(),
                    "采集连接已保存",
                  )
                }
              >
                保存连接
              </Button>
            </>
          ) : null}
        </details>
        {draft.error ? <Notice danger>{draft.error}</Notice> : null}
        <div className="operations-actions">
          <Button
            primary
            disabled={!words.length || !!action.pending || model.running}
            onClick={() =>
              void action.run(
                "zhidao.start",
                {
                  kind: "collect",
                  input: {
                    mode: draft.value.mode,
                    keywords: words,
                    count:
                      draft.value.mode === "precise"
                        ? Math.min(words.length, draft.value.count)
                        : draft.value.count,
                    accountIds: draft.value.accountIds,
                    zhidao: draft.value.zhidao,
                    pansou: draft.value.pansou,
                  },
                  authorized: true,
                },
                (run) => {
                  setSelected([]);
                  model.pick(run);
                },
                "采集任务已开始",
              )
            }
          >
            开始采集
          </Button>
          <small>安全验证、网络错误和真实无结果会分别记录。</small>
        </div>
      </Panel>
      <RunPanel model={model}>
        {(items) => (
          <>
            <div className="operations-transfer">
              <div className="operations-form-grid">
                <Field label="转存到本人百度账号">
                  <Select
                    value={draft.value.targetAccount}
                    onValueChange={(targetAccount) => {
                      draft.update({ targetAccount });
                      setRights(false);
                    }}
                    items={[
                      { value: "", label: "选择已登录的百度网盘账号" },
                      ...data!.accounts
                        .filter(
                          (a) =>
                            a.provider === "baidu" &&
                            a.enabled &&
                            a.status === "connected",
                        )
                        .map((a) => ({ value: a.id, label: a.alias })),
                    ]}
                  />
                </Field>
                <Field label="目标父目录">
                  <input
                    value={draft.value.directory}
                    onChange={(e) => {
                      draft.update({ directory: e.target.value });
                      setRights(false);
                    }}
                  />
                </Field>
              </div>
              <label className="check">
                <input
                  type="checkbox"
                  checked={rights}
                  onChange={(e) => setRights(e.target.checked)}
                />
                我有权保存和分享所选资源
              </label>
              <div className="operations-actions">
                <span>已选{selected.length}项 · 跨页保留，最多100项</span>
                <Button
                  primary
                  disabled={
                    !selected.length ||
                    !rights ||
                    !draft.value.targetAccount ||
                    !!action.pending ||
                    model.running
                  }
                  onClick={() =>
                    void action.run(
                      "zhidao.collect.transfer",
                      {
                        itemIds: selected,
                        accountId: draft.value.targetAccount,
                        directory: draft.value.directory,
                        rightsConfirmed: true,
                      },
                      (result) => {
                        localStorage.setItem("panxu-batch-id", result.batchId);
                        void refresh().catch(() =>
                          notify(
                            "资料已交给转存预检；列表刷新失败，请稍后刷新。",
                            "warning",
                          ),
                        );
                        navigate("batch");
                      },
                      "已交给现有批量预检",
                    )
                  }
                >
                  检查并交给转存
                </Button>
              </div>
            </div>
            <ResultTable
              items={items}
              selected={selected}
              onSelect={(ids) => {
                setSelected(ids);
                setRights(false);
              }}
              running={model.running}
              onChanged={model.refresh}
            />
          </>
        )}
      </RunPanel>
    </OperationsWorkspace>
  );
}
