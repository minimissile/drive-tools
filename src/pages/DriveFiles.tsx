import { useState } from "react";
import { z } from "zod";
import { useAppData, useAppNavigation, useAppSelection } from "../state";
import { useLocalDraft } from "../hooks/useLocalDraft";
import {
  providerIds,
  providerSpecs,
  providerDriveName,
} from "../../shared/providers";
import { Button, Empty, Field, Notice } from "../ui/primitives";
import { Select } from "../ui/Select";
import { OperationsWorkspace } from "../workbench/OperationsWorkspace";
import { LocalDriveIndex } from "../drive-files/LocalDriveIndex";
import { Tabs, TabList, TabPanel } from "../ui/Tabs";
import { DriveBrowser } from "../drive-files/DriveBrowser";
import "../ui/workspace.css";
import "../drive-files/drive-files-page.css";

export default function DriveFiles() {
  const { data } = useAppData();
  const { navigate } = useAppNavigation();
  const { copy } = useAppSelection();
  const [scope, setScope] = useState(0);
  const draft = useLocalDraft(
    `panxu-drive-browser:${data!.dataPath}`,
    {
      provider: "all",
      accountId: copy?.accountId ?? "",
      path: "/",
      view: "local" as "local" | "remote",
    },
    (v) =>
      z
        .object({
          provider: z.string(),
          accountId: z.string(),
          path: z.string(),
          view: z.enum(["local", "remote"]).default("local"),
        })
        .parse(v),
  );
  const accounts = data!.accounts;
  const account = accounts.find((a) => a.id === draft.value.accountId);
  return (
    <OperationsWorkspace
      className="workspace-frame drive-files-workspace"
      title="网盘文件"
      description="同步全盘目录，查找未录入资源；切换实时网盘管理文件与广告素材。"
      action={
        <Button quiet size="compact" onClick={() => navigate("accounts")}>
          管理网盘账号
        </Button>
      }
    >
      {draft.error ? <Notice danger>{draft.error}</Notice> : null}
      <section className="drive-files-context" aria-label="选择本人网盘">
        <div className="drive-files-account-fields">
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
                  label: providerDriveName(id),
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
                { value: "", label: "选择本人网盘账号" },
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
            size="compact"
            className="drive-files-resource-location"
            title={`定位到当前资源的目录：${copy.directory}`}
            onClick={() => {
              draft.update({
                provider: data!.accounts.find((a) => a.id === copy.accountId)!
                  .provider,
                accountId: copy.accountId,
                path: copy.directory,
                view: "remote",
              });
              setScope((v) => v + 1);
            }}
          >
            定位当前资源
          </Button>
        ) : null}
      </section>
      {account ? (
        <Tabs
          className="drive-files-views"
          value={draft.value.view}
          onChange={(view) => draft.update({ view })}
        >
          <TabList
            label="网盘浏览方式"
            items={[
              ["local", "本地目录"],
              ["remote", "实时网盘"],
            ]}
          />
          <TabPanel value="local">
            <LocalDriveIndex
              key={`${data!.dataPath}:${account.id}`}
              account={account}
              workspace={data!.dataPath}
              onOpenRemote={(path) => {
                draft.update({ path, view: "remote" });
                setScope((v) => v + 1);
              }}
            />
          </TabPanel>
          <TabPanel value="remote">
            {account.enabled ? (
              <DriveBrowser
                key={`${account.id}:${scope}`}
                accountId={account.id}
                copy={copy?.accountId === account.id ? copy : undefined}
                initialPath={draft.value.path}
                workspace={data!.dataPath}
                onPathChange={(path) => draft.update({ path })}
              />
            ) : (
              <Empty title="此账号已停用">
                可切回本地目录查看历史；重新启用账号后可访问实时网盘。
              </Empty>
            )}
          </TabPanel>
        </Tabs>
      ) : (
        <Empty
          title={
            accounts.length ? "先选择一个本人网盘账号" : "还没有本人网盘账号"
          }
          action={
            !accounts.length ? (
              <Button primary onClick={() => navigate("accounts")}>
                前往登录
              </Button>
            ) : undefined
          }
        >
          支持百度、夸克、UC、迅雷、光鸭、PikPak 和移动云盘；账号之间分别管理。
        </Empty>
      )}
    </OperationsWorkspace>
  );
}
