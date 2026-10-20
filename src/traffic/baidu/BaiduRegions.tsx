import { baiduProvinces } from "./options";
import { Button } from "../../ui/primitives";
export function BaiduRegions({
  value,
  onChange,
  disabled = false,
}: {
  value: number[];
  onChange(v: number[]): void;
  disabled?: boolean;
}) {
  return (
    <details className="baidu-filter-details">
      <summary>
        地域 · {value.length ? `已选${value.length}个地区` : "全部地域"}
      </summary>
      <div className="baidu-region-options">
        <label>
          <input
            type="checkbox"
            checked={!value.length}
            disabled={disabled}
            onChange={() => onChange([])}
          />
          全部地域
        </label>
        {baiduProvinces.map(([id, label]) => (
          <label key={id}>
            <input
              type="checkbox"
              disabled={disabled}
              checked={value.includes(id)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...value, id]
                    : value.filter((x) => x !== id),
                )
              }
            />
            {label}
          </label>
        ))}
      </div>
      <Button quiet disabled={disabled} onClick={() => onChange([])}>
        清空地域选择
      </Button>
    </details>
  );
}
