import BrowserEnvironments from "../accounts/BrowserEnvironments";
import { Header } from "../ui/primitives";

export default function FingerprintBrowser() {
  return (
    <>
      <Header
        title="指纹浏览器"
        description="管理已有比特窗口、浏览器环境与任务调度，并关联各平台账号。"
      />
      <BrowserEnvironments />
    </>
  );
}
