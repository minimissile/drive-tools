import { Button, Field, Notice } from "../../ui/primitives";
import { Select } from "../../ui/Select";
import { useBaiduResearch } from "./useBaiduResearch";
import { z } from "zod";
const pathsSchema = z.array(
  z.object({
    paths: z.array(
      z.array(
        z.object({
          businessPointId: z.coerce.number().int().positive(),
          businessPointName: z.string(),
        }),
      ),
    ),
  }),
);
export function BaiduBusinessSelector({
  accountId,
  uid,
  name,
  value,
  onChange,
  disabled,
}: {
  accountId: string;
  uid: string | null | undefined;
  name: string;
  value: string;
  onChange(id: string, name: string): void;
  disabled: boolean;
}) {
  const query = useBaiduResearch(accountId, "keywordBusinesses", uid);
  const parsed = pathsSchema.safeParse(query.result?.data);
  const options = parsed.success
    ? parsed.data
        .flatMap((x) => x.paths)
        .filter((p) => p.length >= 2)
        .map((path) => ({
          value: String(path.at(-1)!.businessPointId),
          label: path.map((p) => p.businessPointName).join(" / "),
          name: path.at(-1)!.businessPointName,
        }))
    : [];
  return (
    <div className="baidu-research-form">
      <div className="baidu-keyword-connection">
        <Field label="搜索推广业务名称">
          <input
            aria-label="百度推广业务名称"
            value={name}
            maxLength={100}
            disabled={disabled || query.pending}
            placeholder="输入业务名称后搜索百度业务目录"
            onChange={(e) => onChange("", e.target.value)}
          />
        </Field>
        <Button
          disabled={!name.trim() || disabled || query.pending}
          onClick={() => void query.run({ businessSearch: name })}
        >
          {query.pending ? "正在读取…" : "搜索百度业务"}
        </Button>
      </div>
      <Field label="选择推广业务">
        <Select
          aria-label="百度推广业务"
          value={value}
          disabled={disabled || query.pending}
          items={[
            {
              value: "",
              label: options.length ? "请选择具体业务" : "先搜索百度业务目录",
            },
            ...options,
          ]}
          onValueChange={(id) =>
            onChange(id, options.find((x) => x.value === id)?.name ?? name)
          }
        />
      </Field>
      {query.error ? (
        <Notice warning>{query.error}</Notice>
      ) : query.result && !options.length ? (
        <Notice>未找到可拓词的具体业务，请调整业务名称。</Notice>
      ) : null}
    </div>
  );
}
