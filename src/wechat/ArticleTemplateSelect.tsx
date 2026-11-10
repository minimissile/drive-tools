import { useId } from "react";
import { Select } from "../ui/Select";
import {
  defaultWechatTemplate,
  wechatTemplates,
  type WechatTemplateId,
} from "../../shared/wechat-templates";

export function ArticleTemplateSelect({
  value = defaultWechatTemplate,
  disabled,
  onChange,
}: {
  value?: WechatTemplateId;
  disabled: boolean;
  onChange(value: WechatTemplateId): void;
}) {
  const label = useId();
  return (
    <div className="wechat-template-control">
      <span id={label}>排版模板</span>
      <Select
        value={value}
        aria-labelledby={label}
        disabled={disabled}
        items={wechatTemplates.map((template) => ({
          value: template.id,
          label: template.name,
        }))}
        onValueChange={(id) => onChange(id as WechatTemplateId)}
      />
    </div>
  );
}
