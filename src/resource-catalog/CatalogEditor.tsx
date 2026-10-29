import { useEffect, useRef, useState } from "react";
import {
  catalogSaveSchema,
  type CatalogSaveInput,
  type ResourceCatalog,
} from "../../shared/resource-catalog";
import { readDraft, writeDraft } from "../storage/local-draft";
import { ipc } from "../api/client";
import { Button, Field, Notice } from "../ui/primitives";
import { Select } from "../ui/Select";
import { Dialog } from "../ui/Dialog";
import { useAppActions } from "../state";

export function CatalogEditor({
  catalog,
  categories,
  workspace,
  onSaved,
  onClose,
}: {
  catalog?: ResourceCatalog;
  categories: string[];
  workspace: string;
  onSaved(id: string): void;
  onClose(): void;
}) {
  const key = `panxu-catalog-editor:${workspace}:${catalog?.id ?? "new"}`;
  const defaults: CatalogSaveInput = {
    title: "",
    category: "",
    introduction: "",
    includeSummary: true,
    includeTags: true,
    sort: "title",
    ...(catalog
      ? {
          title: catalog.title,
          category: catalog.category,
          introduction: catalog.introduction,
          includeSummary: catalog.includeSummary,
          includeTags: catalog.includeTags,
          sort: catalog.sort,
          id: catalog.id,
          expectedRevision: catalog.revision,
        }
      : {}),
  };
  const [form, setForm] = useState<CatalogSaveInput>(
    () =>
      readDraft(localStorage, key, (value) => {
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
          sort: v.sort === "updated" ? "updated" : "title",
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
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  useEffect(() => {
    setStorageError(!writeDraft(localStorage, key, form));
  }, [form, key]);
  const patch = (v: Partial<CatalogSaveInput>) =>
    setForm((old) => ({ ...old, ...v }));
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
      const saved = await ipc("resourceCatalog.save", parsed.data);
      try {
        localStorage.removeItem(key);
      } catch {
        /* durable save already succeeded */
      }
      notify("清单已保存，预览将使用该分类的最新资源。", "success");
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
      className="catalog-editor"
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
        按分类持续整理资源，保存后可预览并发布到文档平台。未保存的文字会在本机暂存。
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
                quiet
                disabled={pending}
                onClick={() => {
                  void ipc("resourceCatalog.get", { id: catalog.id })
                    .then(({ catalog: latest }) => {
                      setForm({
                        title: latest.title,
                        category: latest.category,
                        introduction: latest.introduction,
                        includeSummary: latest.includeSummary,
                        includeTags: latest.includeTags,
                        sort: latest.sort,
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
      <Field label="清单标题" required>
        <input
          value={form.title}
          maxLength={120}
          placeholder="例如：英语学习资源清单"
          onChange={(e) => patch({ title: e.target.value })}
          disabled={pending}
        />
      </Field>
      <Field label="资源分类" required hint="读取整类资源，不受资源库分页限制">
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
      <Field label="清单介绍" hint="会出现在公开文档中，请勿填写内部信息">
        <textarea
          value={form.introduction}
          maxLength={4000}
          rows={4}
          placeholder="介绍这类资源的用途和使用方式…"
          onChange={(e) => patch({ introduction: e.target.value })}
          disabled={pending}
        />
      </Field>
      <Field label="资源排序">
        <Select
          value={form.sort}
          disabled={pending}
          onValueChange={(sort) =>
            patch({ sort: sort as CatalogSaveInput["sort"] })
          }
          items={[
            { value: "title", label: "按资源名称" },
            { value: "updated", label: "最近更新优先" },
          ]}
        />
      </Field>
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
    </Dialog>
  );
}
