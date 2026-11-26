import type { PublishingRecord } from "../../shared/zhidao-workflow";

export function PublishingKeywordPlan({
  record,
}: {
  record: PublishingRecord;
}) {
  const generation = record.generation;
  if (!generation?.topics) return null;
  const topics = record.keywordPlan?.topics ?? generation.topics;
  const excluded =
    record.keywordPlan?.excludedKeywords ?? generation.excludedKeywords ?? [];
  const used = new Set(
    topics.flatMap((topic) => [topic.keyword, ...topic.relatedKeywords]),
  );
  const accounted = new Set([
    ...used,
    ...excluded.map((entry) => entry.keyword),
  ]);
  const unknown = record.resource.keywords.filter(
    (keyword) => !accounted.has(keyword),
  );
  return (
    <details className="publishing-keyword-plan">
      <summary>
        关键词取舍明细 · {record.resource.keywords.length}个词 → {topics.length}
        组问答
        {excluded.length ? ` · 排除${excluded.length}个词` : ""}
        {unknown.length ? ` · ${unknown.length}个词未记录原因` : ""}
      </summary>
      <p className="publishing-help">
        每个独立需求生成一条问答，同义词合并；正文直接回答问题。资料不足的词列出所缺依据，最多20条。
      </p>
      <ol className="publishing-keyword-groups">
        {topics.map((topic) => (
          <li key={topic.id}>
            <strong>{topic.keyword}</strong>
            {topic.kind === "knowledge" ? <span>内容解答</span> : null}
            {topic.intent ? <span>{topic.intent}</span> : null}
            {topic.relatedKeywords.length ? (
              <span>并入：{topic.relatedKeywords.join("、")}</span>
            ) : null}
          </li>
        ))}
      </ol>
      {excluded.length ? (
        <ul
          className="publishing-keyword-exclusions"
          aria-label="未采用的关键词与原因"
        >
          {excluded.map((entry) => (
            <li key={entry.keyword}>
              <strong>{entry.keyword}</strong>
              <span>{entry.reason}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {unknown.length ? (
        <p className="publishing-help">
          旧记录未保存以下词的取舍原因：{unknown.join("、")}
          。已发布内容保留，重新生成时才使用新检查规则。
        </p>
      ) : null}
      {generation.research ? (
        <details className="publishing-research">
          <summary>
            补充资料 · {generation.research.sources.length} 个来源
          </summary>
          <p className="publishing-help">
            检索时间：
            {new Date(generation.research.checkedAt).toLocaleString("zh-CN")}
            。用于核对回答事实，不代表网盘文件进度。
          </p>
          <ul className="publishing-keyword-exclusions">
            {generation.research.sources.map((source) => (
              <li key={source.url}>
                <a href={source.url} target="_blank" rel="noreferrer">
                  {source.title}
                </a>
              </li>
            ))}
            {generation.research.gaps.map((gap, index) => (
              <li key={index}>{gap}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </details>
  );
}
