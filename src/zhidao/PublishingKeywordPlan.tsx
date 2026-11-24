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
        每组生成一条问答。关联词表示同一需求，不代表逐字写入正文；问答删减以当前检查列表为准。
      </p>
      <ol className="publishing-keyword-groups">
        {topics.map((topic) => (
          <li key={topic.id}>
            <strong>{topic.keyword}</strong>
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
    </details>
  );
}
