import { Header, Button } from "../ui/primitives";
import { Tabs, TabList, TabPanel } from "../ui/Tabs";
import { useAppNavigation } from "../state";
import DriveAccounts from "../accounts/DriveAccounts";
import WebsiteAccounts from "../accounts/WebsiteAccounts";
export default function Accounts() {
  const { page, navigate } = useAppNavigation();
  const section = page === "website-accounts" ? "websites" : "drives";
  return (
    <Tabs
      value={section}
      onChange={(value) =>
        navigate(value === "websites" ? "website-accounts" : "accounts")
      }
    >
      <Header
        title="账号管理"
        description="统一管理网盘与网站登录，官方窗口登录，会话按账号和工作空间隔离。"
        action={
          <Button quiet onClick={() => navigate("zhidao-accounts")}>
            百度知道账号
          </Button>
        }
      />
      <TabList
        label="账号类型"
        items={[
          ["drives", "网盘账号"],
          ["websites", "网站账号"],
        ]}
      />
      <TabPanel value={section}>
        {section === "websites" ? <WebsiteAccounts /> : <DriveAccounts />}
      </TabPanel>
    </Tabs>
  );
}
