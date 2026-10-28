import type { Provider } from "../../shared/types";
import { normalizedResourceTitle } from "../../shared/resource-names";
import { useIpcQuery } from "../api/useIpcQuery";
import { QueryError } from "../ui/QueryError";
import { Button, LoadingState } from "../ui/primitives";
import { providerName } from "./labels";
import "./intake.css";

export function useResourceSimilarity({
  title,
  provider,
  excludeId,
  originalTitle,
  invalidate,
}: {
  title: string;
  provider: Provider;
  excludeId?: string;
  /** Present only when explicitly editing an existing copy. */
  originalTitle?: string;
  invalidate?: unknown;
}) {
  const enabled = !!title.trim();
  const query = useIpcQuery(
    "resource.similar",
    { title: title.trim(), excludeId },
    { enabled, delay: 300, invalidate },
  );
  const unchanged =
    originalTitle !== undefined &&
    normalizedResourceTitle(originalTitle) === normalizedResourceTitle(title);
  const duplicate = unchanged
    ? undefined
    : query.data?.find(
        (resource) =>
          resource.provider === provider && resource.similarity === 1,
      );
  return {
    ...query,
    enabled,
    duplicate,
    blocked:
      enabled && (query.loading || !!query.error || !query.data || !!duplicate),
  };
}

export function ResourceSimilarity({
  check,
  disabled,
  onOpen,
}: {
  check: ReturnType<typeof useResourceSimilarity>;
  disabled: boolean;
  onOpen(id: string): void;
}) {
  if (!check.enabled) return null;
  return (
    <div className="intake-similarity" aria-label="名称相似检查">
      <QueryError
        title="无法检查是否有相似资源"
        error={check.error}
        loading={check.loading}
        onRetry={check.reload}
      >
        检查完成后即可保存。
      </QueryError>
      {check.loading && !check.data && !check.error ? (
        <LoadingState label="正在检查名称相似的资源…" compact />
      ) : null}
      {check.data?.length ? (
        <section className="intake-similar-resources">
          <p>
            {check.duplicate
              ? "同名资源已在此类网盘入库，请查看并编辑已有记录。"
              : "已有名称相似度达80%的资源，请先核对，避免重复录入。"}
          </p>
          <ul>
            {check.data.map((resource) => (
              <li key={resource.id}>
                <div>
                  <strong>{resource.title}</strong>
                  <small>
                    {providerName(resource.provider)}网盘 · 相似度
                    {Math.round(resource.similarity * 100)}%
                  </small>
                </div>
                <Button
                  size="compact"
                  disabled={disabled}
                  onClick={() => onOpen(resource.id)}
                  aria-label={`查看已有资源：${resource.title}`}
                >
                  查看已有资源
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
