import { QueryError } from "../ui/QueryError";
import { Select } from "../ui/Select";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { Dialog, type DialogProps } from "../ui/Dialog";
import { useEffect, useState } from "react";
import {
  Button,
  Empty,
  Field,
  SearchField,
  LoadingState,
  Notice,
} from "../ui/primitives";
import { accountLabel, providerName } from "../resources/labels";
import { useAppActions, useAppActivity, useAppData } from "../state";
import type { Resource, Platform } from "../../shared/types";
import type { SearchTopic } from "../../shared/search";
import { platformSpecs } from "../../shared/platforms";
import { Pagination } from "../ui/Pagination";
import { updateSelection } from "../lib/selection";

export function SearchDialog(props: Omit<DialogProps, "busy" | "className">) {
  const { busy } = useAppActivity();
  return <Dialog {...props} busy={busy > 0} className="search-dialog" />;
}
export function BindingDialog({
  topic,
  onClose,
  onSaved,
}: {
  topic: SearchTopic;
  onClose(): void;
  onSaved(topic: SearchTopic): void;
}) {
  const { data } = useAppData(),
    { command, notify } = useAppActions(),
    { busy } = useAppActivity();
  const [query, setQuery] = useState(""),
    [page, setPage] = useState(1),
    [resource, setResource] = useState<Resource | null>(null),
    [copyId, setCopyId] = useState(topic.copyId ?? ""),
    [target, setTarget] = useState(topic.splitItemId ?? "whole"),
    [targetPage, setTargetPage] = useState(1);
  const poolResourceId = data!.pools.find(
    (p) => p.id === topic.poolId,
  )?.resourceId;
  useEffect(() => {
    const resourceId = topic.resourceId ?? poolResourceId;
    if (!resourceId) return;
    let alive = true;
    void ipc("resource.get", { id: resourceId })
      .then((r) => {
        if (alive) {
          setResource(r);
          setCopyId(topic.copyId ?? r.copies[0]?.id ?? "");
        }
      })
      .catch((e) => {
        if (alive) notify(e.message, "error");
      });
    return () => {
      alive = false;
    };
  }, [topic.resourceId, topic.copyId, poolResourceId, notify]);
  const {
    data: resources,
    loading,
    error: resourceError,
    reload: retryResources,
  } = useIpcQuery(
    "resource.page",
    { query, page, pageSize: 10 },
    {
      delay: 180,
      keepPrevious: true,
    },
  );
  const {
    data: targets,
    loading: targetLoading,
    error: targetError,
    reload: retryTargets,
  } = useIpcQuery(
    "search.targets",
    { copyId, page: targetPage },
    { enabled: !!copyId },
  );
  const choose = (r: Resource) => {
    setResource(r);
    setCopyId(r.copies[0]?.id ?? "");
    setTarget("whole");
    setTargetPage(1);
  };
  const matching = targets && targets.copyId === copyId;
  const valid =
    matching &&
    (target === "whole"
      ? targets.wholeReady
      : targets.items.some((i) => i.id === target));
  return (
    <SearchDialog title="为选题关联本人资料" onClose={onClose}>
      <p className="search-context">{topic.keyword}</p>
      <Notice>
        选择整份资料或已建好的本人拆分链接。需要新建子链接时，仍在“资料拆分”中完成。
      </Notice>
      <Field label="查找资料">
        <SearchField
          label="查找资料"
          placeholder="按资料标题、标签或说明搜索"
          loading={loading}
          value={query}
          onChange={(value) => {
            setQuery(value);
            setPage(1);
          }}
        />
      </Field>
      <QueryError
        error={resourceError}
        loading={loading}
        onRetry={retryResources}
      />
      <div className="search-resource-options" aria-busy={loading}>
        {loading && !resources?.items.length ? (
          <LoadingState label="正在查找资料…" />
        ) : null}
        {resources?.items
          .filter((r) => !poolResourceId || r.id === poolResourceId)
          .map((r) => (
            <Button
              key={r.id}
              className={resource?.id === r.id ? "selected" : ""}
              onClick={() => choose(r)}
            >
              <strong>{r.title}</strong>
              <small>
                {providerName(r.provider)} · {r.category}
              </small>
            </Button>
          ))}
        {resources && !resources.items.length && !loading && !resourceError ? (
          <Empty title="没有匹配资料" />
        ) : null}
      </div>
      <Pagination
        label="关联资料翻页"
        page={resources?.page ?? page}
        pageSize={10}
        total={resources?.total ?? 0}
        disabled={!resources || loading}
        onPageChange={setPage}
        className=""
      >
        第 {resources?.page ?? page} 页 · 全库检索
      </Pagination>
      {resource ? (
        <Field label="本人资料副本">
          <Select
            value={copyId}
            onValueChange={(nextValue) => {
              setCopyId(nextValue);
              setTarget("whole");
              setTargetPage(1);
            }}
            items={[
              ...resource.copies.map((c) => ({
                value: c.id,
                label: accountLabel(data!.accounts, c.accountId),
              })),
            ]}
          />
        </Field>
      ) : null}
      {copyId ? (
        <div className="search-target-options">
          <h3>可关联的本人分享</h3>
          <QueryError
            error={targetError}
            loading={targetLoading}
            onRetry={retryTargets}
          />
          {!targets ? (
            targetLoading ? (
              <LoadingState label="正在读取已存分享…" compact />
            ) : null
          ) : (
            <>
              <label className="checkbox">
                <input
                  type="radio"
                  name="search-target"
                  checked={target === "whole"}
                  disabled={!targets.wholeReady}
                  onChange={() => setTarget("whole")}
                />
                整份资料{!targets.wholeReady ? "（需先核验本人分享）" : ""}
              </label>
              {targets.items.map((item) => (
                <label key={item.id} className="checkbox">
                  <input
                    type="radio"
                    name="search-target"
                    checked={target === item.id}
                    onChange={() => setTarget(item.id)}
                  />
                  {item.path}
                </label>
              ))}
              {!targets.items.length ? (
                <small>此页没有已核验拆分链接。</small>
              ) : null}
              {targets.total > 50 ? (
                <div className="row">
                  <Button
                    disabled={targetPage <= 1}
                    onClick={() => {
                      setTargetPage((n) => n - 1);
                      setTarget("whole");
                    }}
                  >
                    上一页子链接
                  </Button>
                  <small>第 {targets.page} 页</small>
                  <Button
                    disabled={targets.page * 50 >= targets.total}
                    onClick={() => {
                      setTargetPage((n) => n + 1);
                      setTarget("whole");
                    }}
                  >
                    下一页子链接
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
      <div className="actions">
        <Button
          primary
          disabled={!valid || busy > 0}
          onClick={async () => {
            const result = await command(
              "search.bind",
              {
                id: topic.id,
                copyId,
                splitItemId: target === "whole" ? null : target,
              },
              "本人配套资料已关联。",
            );
            if (result) onSaved(result);
          }}
        >
          保存关联
        </Button>
      </div>
    </SearchDialog>
  );
}
export function CreateTopicDialog({
  onClose,
  onSaved,
  seed,
  topics,
}: {
  onClose(): void;
  onSaved(topic: SearchTopic): void;
  seed?: { copyId: string; splitItemId?: string };
  topics: SearchTopic[];
}) {
  const { command } = useAppActions(),
    { busy } = useAppActivity();
  const [keyword, setKeyword] = useState(""),
    [intent, setIntent] = useState("安装与配置"),
    [platform, setPlatform] = useState<Platform>("csdn"),
    [existing, setExisting] = useState("");
  return (
    <SearchDialog
      title={
        seed
          ? seed.splitItemId
            ? "把拆分资料用于创作"
            : "把这份资料用于创作"
          : "新建搜索选题"
      }
      onClose={onClose}
    >
      {seed ? (
        <Field label="关联选题">
          <Select
            value={existing}
            onValueChange={(nextValue) => setExisting(nextValue)}
            items={[
              { value: "", label: "为此资料新建选题" },
              ...topics.map((t) => ({ value: t.id, label: t.keyword })),
            ]}
          />
        </Field>
      ) : null}
      {!existing ? (
        <div className="fields">
          <Field label="目标关键词" required>
            <input
              aria-label="目标关键词"
              aria-required="true"
              value={keyword}
              maxLength={200}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="例如：Obsidian Windows 安装教程"
            />
          </Field>
          <div className="field-pair">
            <Field label="搜索意图">
              <input
                maxLength={100}
                value={intent}
                onChange={(e) => setIntent(e.target.value)}
              />
            </Field>
            <Field label="目标平台">
              <Select
                value={platform}
                onValueChange={(nextValue) =>
                  setPlatform(nextValue as Platform)
                }
                items={[
                  ...platformSpecs.map((p) => ({ value: p.id, label: p.name })),
                ]}
              />
            </Field>
          </div>
        </div>
      ) : null}
      <div className="actions">
        <Button
          primary
          disabled={(!existing && !keyword.trim()) || busy > 0}
          onClick={async () => {
            const result =
              existing && seed
                ? await command("search.bind", {
                    id: existing,
                    ...seed,
                    splitItemId: seed.splitItemId ?? null,
                  })
                : await command("search.create", {
                    keyword,
                    intent,
                    platform,
                    ...seed,
                  });
            if (result) onSaved(result);
          }}
        >
          {seed ? "关联并继续创作" : "创建选题"}
        </Button>
      </div>
    </SearchDialog>
  );
}
export function PoolTopicDialog({
  poolId: initial,
  onClose,
  onSaved,
}: {
  poolId?: string;
  onClose(): void;
  onSaved(): void;
}) {
  const { data } = useAppData(),
    { command, notify } = useAppActions(),
    { busy } = useAppActivity();
  const [poolId, setPoolId] = useState(initial ?? data!.pools[0]?.id ?? ""),
    [ids, setIds] = useState<string[]>([]),
    [query, setQuery] = useState(""),
    [platform, setPlatform] = useState<Platform>("csdn");
  const pool = data!.pools.find((p) => p.id === poolId),
    words = pool?.keywords.filter((k) => k.word.includes(query)) ?? [];
  return (
    <SearchDialog title="从词池创建搜索选题" onClose={onClose}>
      <div className="field-pair">
        <Field label="已有词池">
          <Select
            value={poolId}
            onValueChange={(nextValue) => {
              setPoolId(nextValue);
              setIds([]);
            }}
            items={[
              { value: "", label: "请选择词池", disabled: true },
              ...data!.pools.map((p) => ({
                value: p.id,
                label: (
                  <>
                    {p.name} · {p.keywords.length} 词
                  </>
                ),
              })),
            ]}
          />
        </Field>
        <Field label="目标平台">
          <Select
            value={platform}
            onValueChange={(nextValue) => setPlatform(nextValue as Platform)}
            items={[
              ...platformSpecs.map((p) => ({ value: p.id, label: p.name })),
            ]}
          />
        </Field>
      </div>
      <Field label="筛选关键词">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </Field>
      <div className="search-keyword-options">
        {words.slice(0, 100).map((k) => (
          <label key={k.id} className="checkbox">
            <input
              type="checkbox"
              checked={ids.includes(k.id)}
              disabled={!ids.includes(k.id) && ids.length >= 100}
              onChange={(e) =>
                setIds((old) =>
                  updateSelection(old, [k.id], e.target.checked, 100),
                )
              }
            />
            {k.word}
          </label>
        ))}
      </div>
      <small>
        已选 {ids.length} / 100 个 · 当前显示前 100
        个匹配词，可输入关键词继续筛选。同平台相同关键词会跳过。
      </small>
      <div className="actions">
        <Button
          primary
          disabled={!ids.length || busy > 0}
          onClick={async () => {
            const r = await command("search.importPool", {
              poolId,
              keywordIds: ids,
              platform,
            });
            if (r) {
              notify(
                `已创建 ${r.created} 个选题，跳过 ${r.skipped} 个已有选题。`,
                "success",
              );
              onSaved();
            }
          }}
        >
          创建所选选题
        </Button>
      </div>
    </SearchDialog>
  );
}
