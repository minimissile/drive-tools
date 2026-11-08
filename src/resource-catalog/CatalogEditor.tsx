import { windowStorage } from "../storage/window-storage";
import { z } from "zod";
import { useEffect, useRef, useState } from "react";
import {
  catalogSaveSchema,
  catalogEntrySchema,
  type CatalogSaveInput,
  type ResourceCatalog,
} from "../../shared/resource-catalog";
import { readDraft, writeDraft } from "../storage/local-draft";
import { ipc } from "../api/client";
import { Button, Field, Notice } from "../ui/primitives";
import { Select } from "../ui/Select";
import { Dialog } from "../ui/Dialog";
import { useAppActions } from "../state";
import { CatalogItemsEditor } from "./CatalogItemsEditor";

export function CatalogEditor({
  catalog,
  categories,
  workspace,
  onSaved,
  onClose,
  initial,
  draftId,
}: {
  catalog?: ResourceCatalog;
  categories: string[];
  workspace: string;
  onSaved(id: string): void;
  onClose(): void;
  initial?: CatalogSaveInput;
  draftId?: string;
}) {
  const key = `panxu-catalog-editor:${workspace}:${catalog?.id ?? draftId ?? "new"}`;
  const defaults: CatalogSaveInput = {
    title: "",
    category: "all",
    introduction: "",
    includeSummary: true,
    includeTags: true,
    sort: "manual",
    selectionMode: "manual",
    entries: [],
    excludedResourceIds: [],
    ...initial,
    ...(catalog
      ? {
          title: catalog.title,
          category: catalog.category,
          introduction: catalog.introduction,
          includeSummary: catalog.includeSummary,
          includeTags: catalog.includeTags,
          sort: catalog.sort,
          selectionMode: catalog.selectionMode ?? "category",
          entries: catalog.entries ?? [],
          excludedResourceIds: catalog.excludedResourceIds ?? [],
          id: catalog.id,
          expectedRevision: catalog.revision,
        }
      : {}),
  };
  const [form, setForm] = useState<CatalogSaveInput>(
    () =>
      readDraft(windowStorage, key, (value) => {
        // Incomplete drafts are valid editing state; never restore IDs or consent from another object.
        const v = value as Partial<CatalogSaveInput>;
        if (
          !v ||
          typeof v.title !== "string" ||
          typeof v.category !== "string" ||
          typeof v.introduction !== "string"
        )
          return defaults;
        return {
          ...defaults,
          title: v.title.slice(0, 120),
          category: v.category,
          introduction: v.introduction.slice(0, 4000),
          includeSummary:
            typeof v.includeSummary === "boolean" ? v.includeSummary : true,
          includeTags:
            typeof v.includeTags === "boolean" ? v.includeTags : true,
          sort: v.sort === "updated" || v.sort === "manual" ? v.sort : "title",
          selectionMode:
            v.selectionMode === "manual" || v.selectionMode === "category"
              ? v.selectionMode
              : defaults.selectionMode,
          entries: Array.isArray(v.entries)
            ? v.entries
                .flatMap((value) => {
                  const parsed = catalogEntrySchema
                    .extend({ title: z.string().max(300).optional() })
                    .safeParse(value);
                  return parsed.success ? [parsed.data] : [];
                })
                .slice(0, 2000)
            : defaults.entries,
          excludedResourceIds:
            catalogSaveSchema.shape.excludedResourceIds.safeParse(
              v.excludedResourceIds,
            ).success
              ? (v.excludedResourceIds ?? defaults.excludedResourceIds)
              : defaults.excludedResourceIds,
          ...(catalog && typeof v.expectedRevision === "number"
            ? { expectedRevision: v.expectedRevision }
            : {}),
        };
      }) ?? defaults,
  );
  const [storageError, setStorageError] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const lock = useRef(false),
    alive = useRef(true);
  const { notify } = useAppActions();
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    setStorageError(!writeDraft(windowStorage, key, form));
  }, [form, key]);
  const patch = (v: Partial<CatalogSaveInput>) =>
    setForm((old) => ({ ...old, ...v }));
  const changeMode = async (selectionMode: "category" | "manual") => {
    if (lock.current) return;
    if (selectionMode === "manual" && catalog && !form.entries?.length) {
      lock.current = true;
      setPending(true);
      setError("");
      try {
        const detail = await ipc("resourceCatalog.get", { id: catalog.id });
        if (alive.current)
          patch({
            selectionMode,
            sort: "manual",
            entries: [...detail.current.items, ...detail.current.excluded].map(
              (item) => ({ resourceId: item.resourceId }),
            ),
          });
      } catch (cause) {
        if (alive.current)
          setError(
            cause instanceof Error ? cause.message : "读取资源失败，请重试。",
          );
      } finally {
        lock.current = false;
        if (alive.current) setPending(false);
      }
    } else
      patch({
        selectionMode,
        sort: selectionMode === "manual" ? "manual" : "title",
      });
  };
  const save = async () => {
    if (lock.current) return;
    const parsed = catalogSaveSchema.safeParse(form);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "请检查清单配置。");
      return;
    }
    lock.current = true;
    setPending(true);
    setError("");
    try {
      const saved = await ipc(
        parsed.data.selectionMode === "manual"
          ? "resourceCatalog.saveManual"
          : "resourceCatalog.save",
        parsed.data,
      );
      try {
        windowStorage.removeItem(key);
      } catch {
        /* durable save already succeeded */
      }
      notify("清单及条目已保存；线上内容可在落地页站点中单独更新。", "success");
      if (alive.current) onSaved(saved.catalog.id);
    } catch (cause) {
      if (alive.current)
        setError(
          cause instanceof Error ? cause.message : "清单未保存，请重试。",
        );
    } finally {
      lock.current = false;
      if (alive.current) setPending(false);
    }
  };
  const options = [
    ...new Set([
      ...categories,
      ...(form.category && form.category !== "all" ? [form.category] : []),
    ]),
  ];
  return (
    <Dialog
      title={catalog ? "编辑清单" : "新建资源清单"}
      onClose={onClose}
      busy={pending}
      className={`catalog-editor${form.selectionMode === "manual" ? " catalog-editor--manual" : ""}`}
      footer={
        <>
          <Button disabled={pending} onClick={onClose}>
            稍后继续
          </Button>
          <Button primary disabled={pending} onClick={() => void save()}>
            {pending ? "正在保存…" : "保存清单"}
          </Button>
        </>
      }
    >
      <p className="muted">
        整理清单和条目，保存后可预览并发布到站点或文档平台。未保存的编辑在本机暂存。
      </p>
      {storageError ? (
        <Notice warning>浏览器暂存空间不可用，请及时保存本次编辑。</Notice>
      ) : null}
      {error ? (
        <div role="alert">
          <Notice danger>
            {error}
            {catalog ? (
              <Button
                disabled={pending}
                onClick={() => {
                  void ipc("resourceCatalog.get", { id: catalog.id })
                    .then(({ catalog: latest }) => {
                      if (!alive.current) return;
                      setForm({
                        title: latest.title,
                        category: latest.category,
                        introduction: latest.introduction,
                        includeSummary: latest.includeSummary,
                        includeTags: latest.includeTags,
                        sort: latest.sort,
                        selectionMode: latest.selectionMode ?? "category",
                        entries: latest.entries ?? [],
                        excludedResourceIds: latest.excludedResourceIds ?? [],
                        id: latest.id,
                        expectedRevision: latest.revision,
                      });
                      setError("");
                    })
                    .catch((cause) =>
                      setError(
                        cause instanceof Error
                          ? cause.message
                          : "读取失败，请重试。",
                      ),
                    );
                }}
              >
                放弃当前编辑并读取最新配置
              </Button>
            ) : null}
          </Notice>
        </div>
      ) : null}
      <div className="catalog-editor-basics">
        <Field label="清单标题" required>
          <input
            value={form.title}
            maxLength={120}
            placeholder="例如：英语学习资源清单"
            onChange={(e) => patch({ title: e.target.value })}
            disabled={pending}
          />
        </Field>
        <Field label="收录方式">
          <Select
            value={form.selectionMode ?? "category"}
            disabled={pending}
            onValueChange={(value) =>
              void changeMode(value as "category" | "manual")
            }
            items={[
              { value: "manual", label: "手动选取 · 可逐项维护" },
              { value: "category", label: "按分类自动收录" },
            ]}
          />
        </Field>
        {form.selectionMode !== "manual" ? (
          <Field
            label="资源分类"
            required
            hint="读取整类资源，不受资源库分页限制"
          >
            <Select
              aria-label="清单资源分类"
              value={form.category}
              onValueChange={(category) => patch({ category })}
              disabled={pending}
              items={[
                { value: "", label: "请选择分类", disabled: true },
                { value: "all", label: "全部分类" },
                ...options.map((value) => ({ value, label: value })),
              ]}
            />
          </Field>
        ) : null}
        <Field label="资源排序">
          <Select
            value={form.sort}
            disabled={pending}
            onValueChange={(sort) =>
              patch({ sort: sort as CatalogSaveInput["sort"] })
            }
            items={[
              ...(form.selectionMode === "manual"
                ? [{ value: "manual", label: "清单条目顺序" }]
                : []),
              { value: "title", label: "按资源名称" },
              { value: "updated", label: "最近更新优先" },
            ]}
          />
        </Field>
        <div className="catalog-editor-intro">
          <Field label="清单介绍" hint="会公开展示，请勿填写内部信息">
            <textarea
              value={form.introduction}
              maxLength={4000}
              rows={3}
              placeholder="介绍这类资源的用途和使用方式…"
              onChange={(e) => patch({ introduction: e.target.value })}
              disabled={pending}
            />
          </Field>
        </div>
      </div>
      <div className="catalog-editor-options">
        <label>
          <input
            type="checkbox"
            checked={form.includeSummary}
            disabled={pending}
            onChange={(e) => patch({ includeSummary: e.target.checked })}
          />
          显示资源说明
        </label>
        <label>
          <input
            type="checkbox"
            checked={form.includeTags}
            disabled={pending}
            onChange={(e) => patch({ includeTags: e.target.checked })}
          />
          显示资源标签
        </label>
      </div>
      {form.selectionMode === "manual" ? (
        <CatalogItemsEditor
          entries={form.entries ?? []}
          categories={categories}
          disabled={pending}
          onChange={(entries) => patch({ entries })}
        />
      ) : (
        <Notice>
          按分类自动收录会跟随资源库变化；在内容预览中删除的条目会持续排除。
          {form.excludedResourceIds?.length ? (
            <div>
              已排除 {form.excludedResourceIds.length} 项。
              <Button
                size="compact"
                disabled={pending}
                onClick={() => patch({ excludedResourceIds: [] })}
              >
                恢复全部已删除条目
              </Button>
              保存后恢复，仍需符合当前分类和分享条件。
            </div>
          ) : null}
        </Notice>
      )}
    </Dialog>
  );
}
