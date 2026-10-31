import { useRef } from "react";
import { Trash2 } from "lucide-react";
import {
  discoverySourceLabels,
  type DiscoveryWord,
} from "../../shared/baidu-discovery";
import { Button } from "../ui/primitives";

export function DiscoveryWordTable({
  words,
  selected,
  queried,
  disabled,
  onSelect,
  onSelectPage,
  onRemove,
}: {
  words: DiscoveryWord[];
  selected: Set<string>;
  queried: Set<string>;
  disabled: boolean;
  onSelect(key: string, checked: boolean): void;
  onSelectPage(checked: boolean): void;
  onRemove(key: string): Promise<void>;
}) {
  const removeButtons = useRef(new Map<string, HTMLButtonElement>());
  const remove = async (key: string) => {
    const index = words.findIndex((word) => word.key === key);
    const next = words[index + 1]?.key || words[index - 1]?.key;
    await onRemove(key);
    if (next)
      requestAnimationFrame(() =>
        removeButtons.current.get(next)?.focus({ preventScroll: true }),
      );
  };
  return (
    <div className="baidu-discovery-table-scroll">
      <table className="baidu-discovery-table">
        <thead>
          <tr>
            <th>
              <input
                aria-label="选择本页关键词"
                type="checkbox"
                checked={
                  words.length > 0 &&
                  words.every((word) => selected.has(word.key))
                }
                onChange={(event) => onSelectPage(event.target.checked)}
              />
            </th>
            <th>关键词</th>
            <th>采集来源</th>
            <th>层级 / 状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {words.map((word) => (
            <tr key={word.key}>
              <td>
                <input
                  aria-label={`选择关键词 ${word.word}`}
                  type="checkbox"
                  checked={selected.has(word.key)}
                  onChange={(event) => onSelect(word.key, event.target.checked)}
                />
              </td>
              <td>
                <strong>{word.word}</strong>
              </td>
              <td>
                <div className="baidu-discovery-word-sources">
                  {[
                    ...new Set(word.origins.map((origin) => origin.source)),
                  ].map((source) => (
                    <span className="baidu-discovery-source" key={source}>
                      {discoverySourceLabels[source]}
                    </span>
                  ))}
                </div>
              </td>
              <td>
                <div className="baidu-discovery-word-state">
                  <span>
                    第 {Math.min(...word.origins.map((origin) => origin.depth))}{" "}
                    层
                  </span>
                  <small>
                    {queried.has(word.key) ? "已纳入查询" : "尚未查询"}
                  </small>
                </div>
              </td>
              <td>
                <Button
                  quiet
                  size="compact"
                  className="baidu-discovery-delete"
                  aria-label={`删除关键词 ${word.word}`}
                  title="直接删除，本轮不再采集此词"
                  disabled={disabled}
                  ref={(button) => {
                    if (button) removeButtons.current.set(word.key, button);
                    else removeButtons.current.delete(word.key);
                  }}
                  onClick={() => void remove(word.key)}
                >
                  <Trash2 size={14} />
                  删除
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
