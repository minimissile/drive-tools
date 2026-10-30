import { useState } from "react";
import { useIpcQuery } from "../api/useIpcQuery";
import { ipc } from "../api/client";
import { useAppActions, useAppNavigation } from "../state";
import { Button, LoadingState } from "../ui/primitives";
import { Monitor, Settings2, SquareArrowOutUpRight } from "lucide-react";
import { PlatformIcon } from "../platforms/PlatformIcon";
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
    <section className="website-publishing-accounts" aria-label="其他发布平台">
      <div className="website-publishing-heading">
        <h2>其他发布平台{rows?.length ? ` · ${rows.length}` : ""}</h2>
        <Button quiet size="compact" onClick={() => navigate("settings")}>
          <Settings2 size={14} aria-hidden="true" />
          管理发布能力
        </Button>
      </div>
      <QueryError
        error={query.error}
        loading={query.loading}
        onRetry={query.reload}
      />
      {!query.data && !query.error ? (
        <LoadingState label="正在读取发布平台账号…" compact />
      ) : null}
      {rows?.length ? (
        <div className="website-account-list">
          {rows.map((binding) => (
            <article className="website-account-row" key={binding.id}>
              <div className="website-account-identity">
                <PlatformIcon platform={binding.platform} />
                <div>
                  <h3>{binding.alias}</h3>
                  <p className="website-account-meta">
                    {
                      platformSpecs.find((spec) => spec.id === binding.platform)
                        ?.name
                    }
                  </p>
                </div>
              </div>
              <div className="website-account-state">
                <p className="website-account-environment">
                  <Monitor size={13} aria-hidden="true" />
                  {environments.find((env) =>
                    env.accounts.some(
                      (ref) => ref.kind === "binding" && ref.id === binding.id,
                    ),
                  )?.name ?? "关联环境待读取"}
                </p>
                <p className="muted">
                  {binding.verifiedAt
                    ? "已记录发布能力，发布前仍需核对身份"
                    : "发布能力待核实"}
                </p>
              </div>
              <div className="website-account-actions">
                <Button
                  size="compact"
                  disabled={!!pending}
                  onClick={() => {
                    setPending(binding.id);
                    void ipc("binding.open", {
                      id: binding.id,
                      contentFormat: defaultContentFormat(binding.platform),
                    })
                      .catch((error) => notify(error.message, "error"))
                      .finally(() => setPending(""));
                  }}
                >
                  <SquareArrowOutUpRight size={14} aria-hidden="true" />
                  {pending === binding.id ? "正在打开…" : "打开平台"}
                </Button>
                {binding.platform === "csdn" ? (
                  <Button
                    quiet
                    size="compact"
                    onClick={() => navigate("csdn-workflow")}
                  >
                    内容发布
                  </Button>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      ) : query.data && !query.error ? (
        <p className="website-publishing-empty">
          尚未接入其他发布平台，可在“连接与设置”中关联已有浏览器环境。
        </p>
      ) : null}
    </section>
  );
}
