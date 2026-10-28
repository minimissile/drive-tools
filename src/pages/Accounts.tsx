import { Suspense } from "react";
import { Header, LoadingState } from "../ui/primitives";
import { Tabs, TabList, TabPanel } from "../ui/Tabs";
import { useAppNavigation } from "../state";
import DriveAccounts from "../accounts/DriveAccounts";
import OtherAccounts from "../accounts/OtherAccounts";

export default function Accounts() {
  const { page, navigate } = useAppNavigation();
  const section = page === "accounts" ? "drives" : "others";
  return (
    <Tabs
      value={section}
      onChange={(value) =>
        navigate(value === "drives" ? "accounts" : "website-accounts")
      }
    >
      <Header
        title="账号管理"
        description="管理网盘与各平台账号，维护登录状态、发布能力和浏览器环境关联。"
      />
      <TabList
        label="账号类型"
        items={[
          ["drives", "网盘账号"],
          ["others", "其他账号"],
        ]}
      />
      <TabPanel value={section}>
        <Suspense fallback={<LoadingState label="正在打开账号管理…" />}>
          {section === "drives" ? (
            <DriveAccounts />
          ) : (
            <OtherAccounts
              initialProvider={
                page === "smzdm-accounts" ? "smzdm" : page === "website-accounts" ? "weibo" : "baidu-zhidao"
              }
            />
          )}
        </Suspense>
      </TabPanel>
    </Tabs>
  );
}
