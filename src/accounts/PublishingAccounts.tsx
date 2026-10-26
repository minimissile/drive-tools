import { useState } from "react";
import { useIpcQuery } from "../api/useIpcQuery";
import { ipc } from "../api/client";
import { useAppActions, useAppNavigation } from "../state";
import { Button, LoadingState, Panel } from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { platformSpecs } from "../../shared/platforms";
import { defaultContentFormat } from "../../shared/channels";
import type { BrowserEnvironmentView } from "../../shared/browser-environments";

/** Existing publishing mappings participate in the same environment model. */
export function PublishingAccounts({
  environments,
}: {
  environments: BrowserEnvironmentView[];
}) {
  const query = useIpcQuery("binding.list", undefined, {
    keepPrevious: true,
    refreshInterval: 2500,
  });
  const { navigate } = useAppNavigation(),
    { notify } = useAppActions();
  const [pending, setPending] = useState("");
  const rows = query.data?.filter((binding) => !binding.websiteAccountId);
  return (
    <Panel
      title="其他发布平台"
      extra={
        <Button quiet onClick={() => navigate("settings")}>
          管理发布能力
        </Button>
      }
    >
      <p className="muted">
        已接入的 CSDN 等发布账号沿用现有能力设置，并关联到统一浏览器环境。
      </p>
      <QueryError
        error={query.error}
        loading={query.loading}
        onRetry={query.reload}
      />
      {!query.data && !query.error ? (
        <LoadingState label="正在读取发布平台账号…" compact />
      ) : null}
      {rows?.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>平台账号</th>
                <th>浏览器环境</th>
                <th>发布能力</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((binding) => (
                <tr key={binding.id}>
                  <td>
                    <strong>{binding.alias}</strong>
                    <small className="table-note">
                      {
                        platformSpecs.find(
                          (spec) => spec.id === binding.platform,
                        )?.name
                      }
                    </small>
                  </td>
                  <td>
                    {environments.find((env) =>
                      env.accounts.some(
                        (ref) =>
                          ref.kind === "binding" && ref.id === binding.id,
                      ),
                    )?.name ?? "关联环境待读取"}
                  </td>
                  <td>
                    {binding.verifiedAt
                      ? "已记录业务能力，操作前仍需核对当前身份"
                      : "业务能力待核实"}
                  </td>
                  <td>
                    <Button
                      quiet
                      disabled={!!pending}
                      onClick={() => {
                        setPending(binding.id);
                      void ipc("binding.open", { id: binding.id, contentFormat: defaultContentFormat(binding.platform) })
                          .catch((error) => notify(error.message, "error"))
                          .finally(() => setPending(""));
                      }}
                    >
                      打开平台
                    </Button>
                    {binding.platform === "csdn" ? (
                      <Button quiet onClick={() => navigate("csdn-workflow")}>
                        内容发布
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : query.data && !query.error ? (
        <p className="muted">
          尚未接入其他发布平台，可在“连接与设置”中关联已有浏览器环境。
        </p>
      ) : null}
    </Panel>
  );
}
