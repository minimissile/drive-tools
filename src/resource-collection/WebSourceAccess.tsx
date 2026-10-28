import {
  collectionWebSpecs,
  type CollectionWebSource,
} from "../../shared/resource-collection";
import { Button } from "../ui/primitives";
import { useOperationAction } from "../zhidao/hooks";

export function WebSourceAccess({
  sources,
}: {
  sources: CollectionWebSource[];
}) {
  const action = useOperationAction();
  if (!sources.length) return null;
  return (
    <div className="operations-actions">
      {sources.map((source) => (
        <Button
          key={source}
          quiet
          disabled={!!action.pending}
          onClick={() =>
            void action.run("zhidao.collection.openSource", { source })
          }
        >
          打开{collectionWebSpecs[source].name}网页
        </Button>
      ))}
      <small>
        直接采集网页搜索结果，无需 API
        Key；遇到登录或安全验证时，可打开原站处理后继续。
      </small>
    </div>
  );
}
