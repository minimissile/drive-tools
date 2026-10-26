import { Suspense } from "react";
import { Header, LoadingState } from "../ui/primitives";
import { Tabs, TabList, TabPanel } from "../ui/Tabs";
import { useAppNavigation } from "../state";
import DriveAccounts from "../accounts/DriveAccounts";
import OtherAccounts from "../accounts/OtherAccounts";
import BrowserEnvironments from "../accounts/BrowserEnvironments";

export default function Accounts() {
  const { page, navigate } = useAppNavigation();
  const section = page === "accounts" ? "drives" : page === "browser-environments" ? "environments" : "others";
  return (
    <Tabs
      value={section}
      onChange={(value) =>
        navigate(value === "drives" ? "accounts" : value === "environments" ? "browser-environments" : "website-accounts")
      }
    >
      <Header
        title="账号管理"
        description="统一管理网盘、平台账号与浏览器环境，同一环境可保持多个平台登录。"
      />
      <TabList
        label="账号类型"
        items={[
          ["drives", "网盘账号"],
          ["others", "其他账号"],
          ["environments", "浏览器环境"],
        ]}
      />
      <TabPanel value={section}>
        <Suspense fallback={<LoadingState label="正在打开账号管理…" />}>
          {section === "drives" ? (
            <DriveAccounts />
          ) : section === "environments" ? <BrowserEnvironments /> : (
            <OtherAccounts
              initialProvider={
                page === "website-accounts" ? "weibo" : "baidu-zhidao"
              }
            />
          )}
        </Suspense>
      </TabPanel>
    </Tabs>
  );
}
