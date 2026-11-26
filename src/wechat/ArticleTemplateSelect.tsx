import { useId } from "react";
import { Select } from "../ui/Select";
import {
  currentWechatTemplateId,
  getWechatTemplate,
  selectableWechatTemplateIds,
  type WechatTemplateId,
} from "../../shared/wechat-templates";

export function ArticleTemplateSelect({
  value,
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
        value={currentWechatTemplateId(value)}
        aria-labelledby={label}
        disabled={disabled}
        items={selectableWechatTemplateIds.map((id) => ({
          value: id,
          label: getWechatTemplate(id).name,
        }))}
        onValueChange={(id) => onChange(id as WechatTemplateId)}
      />
    </div>
  );
}
