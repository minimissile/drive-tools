import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { useAppActions, useAppNavigation } from "../state";
import {
  Button,
  Empty,
  Field,
  LoadingState,
  Notice,
  Panel,
  Status,
} from "../ui/primitives";
import { Select } from "../ui/Select";
import { QueryError } from "../ui/QueryError";
import { CheckboxField } from "../ui/CheckboxField";
import { Pagination } from "../ui/Pagination";
import { updateSelection } from "../lib/selection";
import {
  supplyContextSchema,
  type SupplyDraft,
  type SupplyStage,
} from "../../shared/content-supply";
import { SupplyEditor } from "./Editor";
import { SupplyLogs } from "./Logs";
import "./supply.css";

export const supplyStageLabels: Record<SupplyStage, string> = {
  queued: "等待采集",
  collecting: "采集中",
  blocked: "采集阻塞",
  editing: "待编辑",
  held: "暂不采用",
  delivered: "已交付待审阅",
};
const navigation = supplyContextSchema.extend({
  keyword: z.string().default(""),
  selected: z.string().array().max(20).default([]),
  draftId: z.string().default(""),
});

export function ContentSupplyWorkflow({
  workspace,
  tab,
  onTabChange,
  onOpenWeibo,
}: {
  workspace: string;
  tab: "candidates" | "queue" | "logs";
  onTabChange(value: "candidates" | "queue" | "logs"): void;
  onOpenWeibo(accountId: string, postId: string): Promise<void>;
}) {
  const { notify } = useAppActions(),
    { navigate } = useAppNavigation();
  const draft = useLocalDraft(
    `content-supply-navigation-v1:${workspace}`,
    navigation.parse({}),
    (v) => navigation.parse(v),
  );
  const value = draft.value;
  const snapshot = useIpcQuery("contentSupply.snapshot", undefined, {
    keepPrevious: true,
    refreshInterval: 3000,
  });
  const operations = useIpcQuery("intelligentOps.snapshot", undefined, {
    keepPrevious: true,
  });
  const [page, setPage] = useState(1),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [opened, setOpened] = useState<SupplyDraft | null>(null);
  const lock = useRef(false);
  const alive = useRef(true),
    currentTab = useRef(tab);
  currentTab.current = tab;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const candidates = useIpcQuery(
    "contentSupply.candidates",
    { keyword: value.keyword, page },
    { keepPrevious: true, delay: 200 },
  );
  const work = async (action: () => Promise<unknown>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
      snapshot.reload();
      candidates.reload();
    } catch (e) {
      if (alive.current)
        setError(e instanceof Error ? e.message : "操作失败，请重试。");
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const s = snapshot.data,
    blocked = s?.drafts.filter((d) => d.stage === "blocked") ?? [];
  const selectedDraft =
    s?.drafts.find((v) => v.id === value.draftId) ?? s?.drafts[0];
  const current =
    opened && opened.id === selectedDraft?.id ? opened : selectedDraft;
  const plan = operations.data?.plans.find((p) => p.id === value.planId);
  const accounts = (operations.data?.accounts ?? [])
    .filter((a) => a.channel === "zhihu" || a.channel === "weibo")
    .filter((a) => !plan || plan.accounts.some((p) => p.accountId === a.id));
  const start = () =>
    work(async () => {
      const result = await ipc("contentSupply.start", {
        sourceIds: value.selected,
        direction: value.direction,
        audience: value.audience,
        planId: value.planId,
        accountId: value.accountId,
      });
      if (alive.current)
        draft.update({
          selected: [],
          draftId: result.ids[0] ?? "",
        });
      if (alive.current && currentTab.current === "candidates") {
        onTabChange("queue");
        setOpened(null);
      }
      notify(
        `已处理 ${result.ids.length} 项，复用 ${result.reused} 个原编辑单；新任务按队列采集`,
        "success",
      );
    });
  const unavailable = busy || !!s?.busy;
  return (
    <div className="content-supply">
      {draft.error ? <Notice warning>{draft.error}</Notice> : null}
      {error ? <Notice danger>{error}</Notice> : null}
      <QueryError
        error={snapshot.error}
        loading={snapshot.loading}
        onRetry={snapshot.reload}
      />
      {!s && !snapshot.error ? (
        <LoadingState label="正在读取供稿队列…" />
      ) : null}
      {tab === "candidates" ? (
        <>
          <Panel
            title="从本地知识库准备供稿"
            extra={
              <Button
                size="compact"
                onClick={() => navigate("intelligent-operations")}
              >
                管理运营计划
              </Button>
            }
          >
            <div className="supply-context-fields">
              <Field label="关联运营计划">
                <Select
                  aria-label="供稿关联运营计划"
                  value={value.planId}
                  disabled={unavailable || !operations.data}
                  items={[
                    { value: "", label: "独立编辑单" },
                    ...(operations.data?.plans ?? []).map((p) => ({
                      value: p.id,
                      label: p.name,
                    })),
                  ]}
                  onValueChange={(planId) => {
                    const p = operations.data?.plans.find(
                      (v) => v.id === planId,
                    );
                    draft.update({
                      planId,
                      accountId: "",
                      ...(p
                        ? { direction: p.direction, audience: p.audience }
                        : {}),
                    });
                  }}
                />
              </Field>
              <Field label="面向账号">
                <Select
                  aria-label="供稿目标账号"
                  value={value.accountId}
                  disabled={unavailable || !operations.data}
                  items={[
                    { value: "", label: "先准备公共编辑稿" },
                    ...accounts.map((a) => ({
                      value: a.id,
                      label: `${a.channel === "zhihu" ? "知乎" : "微博"} · ${a.label}`,
                    })),
                  ]}
                  onValueChange={(accountId) => {
                    const positioning = plan?.accounts.find(
                      (a) => a.accountId === accountId,
                    )?.positioning;
                    draft.update({
                      accountId,
                      ...(positioning ? { direction: positioning } : {}),
                    });
                  }}
                />
              </Field>
              <Field label="内容方向">
                <input
                  aria-label="供稿内容方向"
                  value={value.direction}
                  maxLength={1000}
                  disabled={unavailable}
                  placeholder="例如：软件工具与数字资料整理"
                  onChange={(e) => draft.update({ direction: e.target.value })}
                />
              </Field>
              <Field label="受众">
                <input
                  aria-label="供稿受众"
                  value={value.audience}
                  maxLength={1000}
                  disabled={unavailable}
                  placeholder="这篇内容帮助谁"
                  onChange={(e) => draft.update({ audience: e.target.value })}
                />
              </Field>
            </div>
            <QueryError
              error={operations.error}
              loading={operations.loading}
              onRetry={operations.reload}
            />
            <div className="supply-toolbar">
              <Field label="本地关键词 · 多词匹配任一项">
                <input
                  aria-label="供稿本地关键词"
                  value={value.keyword}
                  maxLength={200}
                  placeholder="软件 模板 PPT 壁纸；留空看全部"
                  onChange={(e) => {
                    draft.update({ keyword: e.target.value });
                    setPage(1);
                  }}
                />
              </Field>
              <Button
                primary
                disabled={
                  !s ||
                  unavailable ||
                  !value.selected.length ||
                  !value.direction.trim() ||
                  !!snapshot.error
                }
                onClick={() => void start()}
              >
                采集并建立编辑单
                {value.selected.length ? ` · ${value.selected.length}` : ""}
              </Button>
              {value.selected.length ? (
                <Button
                  size="compact"
                  disabled={unavailable}
                  onClick={() => draft.update({ selected: [] })}
                >
                  清空选择
                </Button>
              ) : null}
            </div>
            <p className="supply-muted">
              只读取本地归档，不消耗列表请求。采集会下载缺失图片；成功项复用。新增列表请到“发现与采集”按需请求。
            </p>
            <QueryError
              error={candidates.error}
              loading={candidates.loading}
              onRetry={candidates.reload}
            />
            {!candidates.data && !candidates.error ? (
              <LoadingState label="正在查找本地候选…" />
            ) : null}
            {candidates.data ? (
              <>
                <div className="row spread supply-summary">
                  <small>
                    归档帖子 {candidates.data.allPosts} 条 · 当前匹配{" "}
                    {candidates.data.total} 条 · 已选 {value.selected.length}/20
                  </small>
                  <CheckboxField
                    label="选择本页未建单项"
                    disabled={
                      unavailable ||
                      !candidates.data.items.some((v) => !v.draftId)
                    }
                    checked={
                      candidates.data.items.some((v) => !v.draftId) &&
                      candidates.data.items
                        .filter((v) => !v.draftId)
                        .every((v) => value.selected.includes(v.id))
                    }
                    onChange={(e) =>
                      draft.update({
                        selected: updateSelection(
                          value.selected,
                          candidates
                            .data!.items.filter((v) => !v.draftId)
                            .map((v) => v.id),
                          e.target.checked,
                          20,
                        ),
                      })
                    }
                  />
                </div>
                {candidates.data.items.length ? (
                  <div className="supply-candidates">
                    {candidates.data.items.map((item) => (
                      <div className="supply-candidate" key={item.id}>
                        <CheckboxField
                          label={
                            <>
                              <strong>{item.text || "无正文帖子"}</strong>
                              <small>
                                {item.author} ·{" "}
                                {item.kind === "images" ? "图文" : "文字"} ·{" "}
                                {item.reason}
                              </small>
                            </>
                          }
                          checked={value.selected.includes(item.id)}
                          disabled={unavailable || !!item.draftId}
                          onChange={(e) =>
                            draft.update({
                              selected: updateSelection(
                                value.selected,
                                [item.id],
                                e.target.checked,
                                20,
                              ),
                            })
                          }
                        />
                        {item.draftId ? (
                          <Button
                            size="compact"
                            onClick={() => {
                              draft.update({
                                draftId: item.draftId!,
                              });
                              onTabChange("queue");
                              setOpened(null);
                            }}
                          >
                            {item.stage
                              ? supplyStageLabels[item.stage]
                              : "打开编辑单"}
                          </Button>
                        ) : (
                          <Button
                            size="compact"
                            quiet
                            onClick={() =>
                              void ipc("system.external", { url: item.url })
                            }
                          >
                            查看原帖
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <Empty
                    title={
                      value.keyword
                        ? "没有匹配该方向的本地素材"
                        : "尚无本地图文候选"
                    }
                  >
                    {value.keyword
                      ? "换关键词或查看全部，不会自动把无关帖子当成运营稿。"
                      : "先在“发现与采集”获取列表，完整响应会入库供这里复用。"}
                  </Empty>
                )}
                <Pagination
                  page={candidates.data.page}
                  pageSize={candidates.data.pageSize}
                  total={candidates.data.total}
                  onPageChange={setPage}
                  label="供稿候选分页"
                />
              </>
            ) : null}
          </Panel>
        </>
      ) : null}
      {tab === "queue" ? (
        <>
          {s ? (
            <>
              <div className="supply-queue-toolbar">
                <Field label="选择编辑单">
                  <Select
                    aria-label="选择供稿编辑单"
                    value={current?.id ?? ""}
                    items={
                      s.drafts.length
                        ? s.drafts.map((d) => ({
                            value: d.id,
                            label: `${supplyStageLabels[d.stage]} · ${d.editorial.title || d.source?.text.slice(0, 50) || d.sourceId}`,
                          }))
                        : [{ value: "", label: "暂无编辑单" }]
                    }
                    disabled={!s.drafts.length}
                    onValueChange={(draftId) => {
                      draft.update({ draftId });
                      setOpened(null);
                    }}
                  />
                </Field>
                <small>
                  {s.drafts.length} 个编辑单 · {blocked.length} 项采集阻塞
                </small>
                {s.collecting ? (
                  <Button
                    size="compact"
                    disabled={busy}
                    onClick={() =>
                      void work(async () => {
                        await ipc("contentSupply.pause");
                        notify("完成当前项后暂停，已采集内容保留", "info");
                      })
                    }
                  >
                    停止后续采集
                  </Button>
                ) : blocked.length ? (
                  <Button
                    size="compact"
                    disabled={unavailable}
                    onClick={() =>
                      void work(() =>
                        ipc("contentSupply.resume", {
                          ids: blocked.slice(0, 20).map((d) => d.id),
                        }),
                      )
                    }
                  >
                    继续阻塞项 · 最多20项
                  </Button>
                ) : null}
              </div>
              {current ? (
                current.source ? (
                  <SupplyEditor
                    key={`${current.id}:${current.version}`}
                    workspace={workspace}
                    draft={current}
                    latest={selectedDraft}
                    operations={operations.data ?? undefined}
                    ai={s.ai}
                    onOpenWeibo={onOpenWeibo}
                    onSaved={(next) => {
                      setOpened(next.stage === "queued" ? null : next);
                      snapshot.reload();
                      candidates.reload();
                    }}
                  />
                ) : (
                  <Panel title="原素材采集">
                    <Status
                      kind={current.stage === "blocked" ? "danger" : "normal"}
                    >
                      {supplyStageLabels[current.stage]}
                    </Status>
                    <p>{current.reason}</p>
                    <small>
                      来源 {current.sourceId} · 编辑单 {current.id}
                    </small>
                  </Panel>
                )
              ) : (
                <Panel title="编辑队列">
                  <Empty title="从本地候选建立第一份编辑单">
                    选择相关图文后批量采集，在这里准备作者观点、核对来源并交付待审阅稿。
                  </Empty>
                </Panel>
              )}
            </>
          ) : null}
        </>
      ) : null}
      {tab === "logs" ? (
        <>
          <SupplyLogs />
        </>
      ) : null}
    </div>
  );
}
