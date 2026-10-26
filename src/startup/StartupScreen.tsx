import { LoaderCircle, RotateCw } from "lucide-react";
import brand from "../assets/brand/panxu-mark.svg";
import illustration from "./startup-art.svg";
import { Button } from "../ui/primitives";

/** Startup follows the local snapshot lifecycle; no progress guesses or forced delay. */
export function StartupScreen({
  error,
  loading,
  onRetry,
}: {
  error: string;
  loading: boolean;
  onRetry(): void;
}) {
  return (
    <div className="startup-screen">
      <div className="startup-brand">
        <img src={brand} width="40" height="40" alt="" />
        <span>
          盘序<small>PANXU STUDIO</small>
        </span>
      </div>
      <main className="startup-content" aria-labelledby="startup-title">
        <img
          className="startup-art"
          src={illustration}
          width="560"
          height="400"
          alt=""
        />
        <h1 id="startup-title">让每份资源，产生内容。</h1>
        <p className="startup-description">
          从整理到创作，你的工作从这里接续。
        </p>
        {error ? (
          <div className="startup-error" role="alert">
            <strong>本地工作空间暂未打开</strong>
            <p>{error}</p>
            <Button disabled={loading} onClick={onRetry}>
              <RotateCw size={14} />
              {loading ? "正在重试…" : "重新读取"}
            </Button>
          </div>
        ) : (
          <p className="startup-status" role="status">
            <LoaderCircle size={16} className="spin" aria-hidden="true" />
            正在打开本地工作空间…
          </p>
        )}
      </main>
      <footer className="startup-footer">
        本地优先 · 资源与内容在此有序连接
      </footer>
    </div>
  );
}
