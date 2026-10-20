import { Select } from "../ui/Select";
import { ipc } from "../api/client";
import { useEffect, useState } from "react";
import { Plus, Save, Trash2 } from "lucide-react";
import { Button, Field } from "../ui/primitives";
import { useAppActions } from "../state";
import {
  builtinCreativeTemplates,
  contentFormats,
  studioRatios,
} from "../../shared/studio-options";
import type { CreativePackage, CreativeTemplate } from "../../shared/studio";
export interface CreativeConfig {
  format: CreativePackage["format"];
  templateId: string;
  brief: string;
  aspectRatio: CreativePackage["aspectRatio"];
  pageCount: number;
}
export default function CreativeSetup({
  value,
  onChange,
  disabled,
}: {
  value: CreativeConfig;
  onChange(value: CreativeConfig): void;
  disabled: boolean;
}) {
  const { command, notify } = useAppActions();
  const [templates, setTemplates] = useState<CreativeTemplate[]>([
      ...builtinCreativeTemplates,
    ]),
    [custom, setCustom] = useState(false),
    [name, setName] = useState(""),
    [style, setStyle] = useState(""),
    [instruction, setInstruction] = useState("");
  useEffect(() => {
    let alive = true;
    void ipc("studio.templates")
      .then((list) => {
        if (alive) setTemplates(list);
      })
      .catch((e) => {
        if (alive) notify(e.message, "error");
      });
    return () => {
      alive = false;
    };
  }, [notify]);
  const selected =
    templates.find((t) => t.id === value.templateId) ?? templates[0];
  return (
    <section className="creative-setup" aria-label="新内容设置">
      <div className="creative-format-tabs" aria-label="营销内容形式">
        {Object.entries(contentFormats).map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={value.format === id}
            disabled={disabled}
            onClick={() =>
              onChange({
                ...value,
                format: id as CreativeConfig["format"],
                aspectRatio: id === "video" ? "9:16" : value.aspectRatio,
              })
            }
          >
            {label}
          </button>
        ))}
      </div>
      <div className="row spread">
        <strong>选择创作模板</strong>
        <Button
          quiet
          disabled={disabled}
          onClick={() => {
            setCustom(!custom);
            setName("");
            setStyle(selected.style);
            setInstruction(selected.instruction);
          }}
        >
          <Plus size={13} />
          保存自定义模板
        </Button>
      </div>
      <div className="creative-template-grid">
        {templates.map((t) => (
          <button
            key={t.id}
            type="button"
            disabled={disabled}
            className={t.id === value.templateId ? "selected" : ""}
            aria-pressed={t.id === value.templateId}
            onClick={() => onChange({ ...value, templateId: t.id })}
          >
            <strong>{t.name}</strong>
            <small>{t.description}</small>
          </button>
        ))}
      </div>
      {custom ? (
        <div className="creative-custom-template">
          <Field label="模板名称">
            <input
              aria-label="自定义模板名称"
              value={name}
              maxLength={60}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="视觉风格">
            <textarea
              aria-label="自定义模板风格"
              value={style}
              maxLength={2000}
              onChange={(e) => setStyle(e.target.value)}
            />
          </Field>
          <Field label="内容结构与要求">
            <textarea
              aria-label="自定义模板要求"
              value={instruction}
              maxLength={3000}
              onChange={(e) => setInstruction(e.target.value)}
            />
          </Field>
          <div className="row">
            <Button
              disabled={
                disabled || !name.trim() || !style.trim() || !instruction.trim()
              }
              onClick={async () => {
                const result = await command("studio.templateSave", {
                  name,
                  style,
                  instruction,
                  description: "我的创作模板",
                  accent: selected.accent,
                });
                if (result) {
                  setTemplates((old) => [...old, result]);
                  onChange({ ...value, templateId: result.id });
                  setCustom(false);
                }
              }}
            >
              <Save size={13} />
              另存模板
            </Button>
            {!selected.builtin ? (
              <Button
                disabled={disabled}
                onClick={async () => {
                  const result = await command("studio.templateSave", {
                    id: selected.id,
                    name: name || selected.name,
                    style,
                    instruction,
                    description: selected.description,
                    accent: selected.accent,
                  });
                  if (result) {
                    const list = await ipc("studio.templates");
                    setTemplates(list);
                    setCustom(false);
                  }
                }}
              >
                更新所选模板
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {!selected.builtin ? (
        <Button
          quiet
          disabled={disabled}
          onClick={async () => {
            await command("studio.templateDelete", { id: selected.id });
            setTemplates((old) => old.filter((t) => t.id !== selected.id));
            onChange({ ...value, templateId: "resource-guide" });
          }}
        >
          <Trash2 size={12} />
          删除所选自定义模板
        </Button>
      ) : null}
      <div className="creative-config-fields">
        <Field label="本次创作要求">
          <textarea
            aria-label="营销创作要求"
            value={value.brief}
            disabled={disabled}
            maxLength={3000}
            placeholder="填写受众、使用场景、语气、重点卖点或画面要求"
            onChange={(e) => onChange({ ...value, brief: e.target.value })}
          />
        </Field>
        {value.format !== "text" ? (
          <div className="row">
            <Field label="画面比例">
              <Select
                aria-label="新内容画面比例"
                disabled={disabled}
                value={value.aspectRatio}
                onValueChange={(nextValue) =>
                  onChange({
                    ...value,
                    aspectRatio: nextValue as CreativeConfig["aspectRatio"],
                  })
                }
                items={[...studioRatios.map((r) => ({ value: r, label: r }))]}
              />
            </Field>
            {value.format === "carousel" ? (
              <Field label="图文页数">
                <input
                  aria-label="图文页数"
                  disabled={disabled}
                  type="number"
                  min={1}
                  max={8}
                  value={value.pageCount}
                  onChange={(e) =>
                    onChange({
                      ...value,
                      pageCount: Math.max(
                        1,
                        Math.min(8, Number(e.target.value) || 1),
                      ),
                    })
                  }
                />
              </Field>
            ) : null}
          </div>
        ) : null}
      </div>
      <small>
        以上设置用于新内容。AI先生成可编辑方案，图片和动态视频由独立素材模型生成并计费。
      </small>
    </section>
  );
}
