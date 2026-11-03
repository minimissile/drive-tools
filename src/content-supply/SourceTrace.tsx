import type { ContentProvenance } from "../../shared/content-sources";
import { ipc } from "../api/client";
import { Button, Notice } from "../ui/primitives";

/** Channel reviewers inspect the original editorial evidence without fetching again. */
export function ContentSourceTrace({ source }: { source: ContentProvenance }) {
  const e = source.editorial;
  return (
    <Notice>
      素材来源：皮皮虾 · {source.author}，含 {source.comments.length}{" "}
      条引用评论。
      <Button
        size="compact"
        onClick={() => void ipc("system.external", { url: source.url })}
      >
        查看原帖
      </Button>
      {e ? (
        <details>
          <summary>编辑记录与使用依据</summary>
          <p>内容方向：{e.direction}</p>
          {e.angle ? <p>核心问题：{e.angle}</p> : null}
          <p>作者新增判断：{e.contribution}</p>
          {e.checks ? <p>交付时核对清单：{e.checks}</p> : null}
          <p>
            AI参与：
            {e.aiAssisted
              ? "已记录AI辅助，平台声明应与实际一致"
              : "此编辑单未记录AI辅助"}
          </p>
          <ul>
            {e.rights.map((right, index) => (
              <li key={`${right.asset}:${index}`}>
                {right.asset === "text"
                  ? "原文参考"
                  : right.asset.startsWith("image-")
                    ? `配图 ${right.asset.slice(6)}`
                    : "引用评论"}{" "}
                ·{" "}
                {(
                  {
                    reference: "背景参考",
                    own: "本人原创",
                    authorized: "已授权",
                    license: "许可范围内",
                    "public-domain": "公共领域",
                    quotation: "必要引用",
                  } as Record<string, string>
                )[right.basis] ?? right.basis}
                ：{right.evidence}
              </li>
            ))}
          </ul>
          <small>
            编辑单 {e.id} · 交付版本 {e.version}
            ；使用依据由编辑记录，仍需按当前稿件核实。
          </small>
        </details>
      ) : null}
    </Notice>
  );
}
