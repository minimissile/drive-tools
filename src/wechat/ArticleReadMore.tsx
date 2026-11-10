import { Field } from "../ui/primitives";
import { Select } from "../ui/Select";
import {
  resolveWechatReadMore,
  type WechatReadMore,
  type WechatReadMoreEntry,
} from "../../shared/wechat-read-more";

export function ArticleReadMore({
  body,
  entries,
  value,
  disabled,
  onChange,
}: {
  body: string;
  entries: WechatReadMoreEntry[];
  value?: WechatReadMore;
  disabled: boolean;
  onChange(value: WechatReadMore): void;
}) {
  const selected = resolveWechatReadMore(body, entries, value);
  const showResources = entries.length > 1 || selected.missing;
  return (
    <div className="wechat-read-more">
      <div
        className="wechat-read-more-controls"
        data-multiple={showResources || undefined}
      >
        <Field label="原文链接">
          <Select
            value={value?.kind ?? "drive"}
            disabled={disabled}
            items={[
              { value: "drive", label: "网盘链接" },
              { value: "landing", label: "资源落地页" },
              { value: "redirect", label: "短链接（直达）" },
            ]}
            onValueChange={(kind) =>
              onChange({
                kind: kind as WechatReadMore["kind"],
                linkId: value?.linkId ?? selected.entry?.linkId,
              })
            }
          />
        </Field>
        {showResources ? (
          <Field label="链接对应资源">
            <Select
              value={value?.linkId ?? ""}
              disabled={disabled}
              items={[
                { value: "", label: "自动选择正文第一条资源" },
                ...(value?.linkId && !selected.entry
                  ? [
                      {
                        value: value.linkId,
                        label: "原资源已移除",
                        disabled: true,
                      },
                    ]
                  : []),
                ...entries.map((entry, index) => ({
                  value: entry.linkId,
                  label:
                    entries.filter((item) => item.title === entry.title)
                      .length > 1
                      ? `${entry.title}（${index + 1}）`
                      : entry.title,
                })),
              ]}
              onValueChange={(linkId) =>
                onChange({
                  kind: value?.kind ?? "drive",
                  linkId: linkId || undefined,
                })
              }
            />
          </Field>
        ) : null}
        <div className="wechat-read-more-address">
          <span className="muted">文末“阅读原文”将打开</span>
          <span
            title={selected.url}
            className={selected.issue ? "wechat-read-more-issue" : ""}
            role={selected.issue ? "status" : undefined}
          >
            {selected.issue ||
              selected.url ||
              "正文暂无网盘资源，暂不设置链接。"}
          </span>
        </div>
      </div>
    </div>
  );
}
