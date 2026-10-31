import type { NewDriveBrowserPreview } from "../../shared/drive-browser";
import { Notice } from "../ui/primitives";

export function DriveBrowserIdentity({
  preview,
}: {
  preview: NewDriveBrowserPreview;
}) {
  return (
    <section className="drive-browser-preview" aria-label="读取到的百度账号">
      <h3>核对百度账号</h3>
      <dl>
        <div>
          <dt>账号</dt>
          <dd>{preview.nickname || "—"}</dd>
        </div>
        <div>
          <dt>百度 UID</dt>
          <dd>{preview.uid}</dd>
        </div>
        <div>
          <dt>实际出口</dt>
          <dd>{preview.exitIp}</dd>
        </div>
        <div>
          <dt>运行状态</dt>
          <dd>{preview.headless ? "后台无头环境" : "可见窗口正在运行"}</dd>
        </div>
      </dl>
      {!preview.headless ? (
        <Notice warning>
          完成保存后，可在此账号的浏览器管理中转为后台运行，再核验登录。
        </Notice>
      ) : null}
    </section>
  );
}
