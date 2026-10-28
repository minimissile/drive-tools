import { useState } from "react";
import { z } from "zod";
import { useAppData, useAppNavigation, useAppSelection } from "../state";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { providerIds, providerSpecs } from "../../shared/providers";
import { Button, Empty, Field, Notice, Panel } from "../ui/primitives";
import { Select } from "../ui/Select";
import { OperationsWorkspace } from "../workbench/OperationsWorkspace";
import { DriveBrowser } from "../drive-files/DriveBrowser";

export default function DriveFiles() {
  const { data } = useAppData();
  const { navigate } = useAppNavigation();
  const { copy } = useAppSelection();
  const [scope, setScope] = useState(0);
  const draft = useLocalDraft(
    `panxu-drive-browser:${data!.dataPath}`,
    { provider: "all", accountId: copy?.accountId ?? "", path: "/" },
    (v) =>
      z
        .object({
          provider: z.string(),
          accountId: z.string(),
          path: z.string(),
        })
        .parse(v),
  );
  const accounts = data!.accounts.filter(
    (a) => a.enabled && a.status === "connected",
  );
  const account = accounts.find((a) => a.id === draft.value.accountId);
  return (
    <OperationsWorkspace
      title="网盘文件"
      description="浏览本人网盘中的资源，管理文件与广告素材，将核验后的分享归档到资源库。"
    >
      {draft.error ? <Notice danger>{draft.error}</Notice> : null}
      <Panel
        title="选择本人网盘"
        extra={
          <Button quiet onClick={() => navigate("accounts")}>
            管理网盘账号
          </Button>
        }
      >
        <div className="operations-form-grid">
          <Field label="网盘类型">
            <Select
              value={draft.value.provider}
              onValueChange={(provider) =>
                draft.update({ provider, accountId: "", path: "/" })
              }
              items={[
                { value: "all", label: "全部网盘" },
                ...providerIds.map((id) => ({
                  value: id,
                  label: providerSpecs[id].name + "网盘",
                })),
              ]}
            />
          </Field>
          <Field label="本人账号">
            <Select
              value={draft.value.accountId}
              onValueChange={(accountId) =>
                draft.update({ accountId, path: "/" })
              }
              items={[
                { value: "", label: "选择已登录的本人账号" },
                ...accounts
                  .filter(
                    (a) =>
                      draft.value.provider === "all" ||
                      a.provider === draft.value.provider,
                  )
                  .map((a) => ({
                    value: a.id,
                    label: `${a.alias} · ${providerSpecs[a.provider].name}`,
                  })),
              ]}
            />
          </Field>
        </div>
        {copy?.folderId && accounts.some((a) => a.id === copy.accountId) ? (
          <Button
            quiet
            onClick={() => {
              draft.update({
                provider: data!.accounts.find((a) => a.id === copy.accountId)!
                  .provider,
                accountId: copy.accountId,
                path: copy.directory,
              });
              setScope((v) => v + 1);
            }}
          >
            定位到当前资源的目录：{copy.directory}
          </Button>
        ) : null}
      </Panel>
      {account ? (
        <DriveBrowser
          key={`${account.id}:${scope}`}
          accountId={account.id}
          copy={copy}
          initialPath={draft.value.path}
          workspace={data!.dataPath}
          onPathChange={(path) => draft.update({ path })}
        />
      ) : (
        <Empty
          title={
            accounts.length
              ? "先选择一个本人网盘账号"
              : "还没有已登录的本人网盘账号"
          }
          action={
            !accounts.length ? (
              <Button primary onClick={() => navigate("accounts")}>
                前往登录
              </Button>
            ) : undefined
          }
        >
          支持百度、夸克、UC、迅雷、光鸭和 PikPak；账号之间分别管理。
        </Empty>
      )}
    </OperationsWorkspace>
  );
}
