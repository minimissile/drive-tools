import { Suspense } from "react";
import { Header, LoadingState } from "../ui/primitives";
import { Tabs, TabList, TabPanel } from "../ui/Tabs";
import { useAppNavigation } from "../state";
import DriveAccounts from "../accounts/DriveAccounts";
import OtherAccounts from "../accounts/OtherAccounts";
import "../accounts/accounts.css";

export default function Accounts() {
  const { page, navigate } = useAppNavigation();
  const section = page === "accounts" ? "drives" : "others";
  return (
    <Tabs
      className="accounts-workspace"
      value={section}
      onChange={(value) =>
        navigate(value === "drives" ? "accounts" : "website-accounts")
      }
    >
      <div className="accounts-heading">
        <Header title="账号管理" />
        <TabList
          label="账号类型"
          items={[
            ["drives", "网盘账号"],
            ["others", "其他账号"],
          ]}
        />
      </div>
      <TabPanel value={section}>
        <Suspense fallback={<LoadingState label="正在打开账号管理…" />}>
          {section === "drives" ? (
            <DriveAccounts />
          ) : (
            <OtherAccounts
              initialProvider={
                page === "smzdm-accounts"
                  ? "smzdm"
                  : page === "website-accounts"
                    ? "weibo"
                    : "baidu-zhidao"
              }
            />
          )}
        </Suspense>
      </TabPanel>
    </Tabs>
  );
}
