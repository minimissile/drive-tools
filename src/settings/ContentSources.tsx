import { useIpcQuery } from "../api/useIpcQuery";
import {
  Panel,
  Status,
  LoadingState,
  Button,
  Field,
  Notice,
} from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { SecretField } from "./SecretField";
import { useAppActions, useAppActivity } from "../state";
import { useState } from "react";
import { formatTime } from "../lib/format";

export function ContentSourcesSettings() {
  const { command } = useAppActions(),
    { busy } = useAppActivity();
  const [keyword, setKeyword] = useState("生活趣事");
  const config = useIpcQuery("pipix.discoveryConfig", undefined, {
    keepPrevious: true,
  });
  return (
    <Panel
      title="TikHub · 内容数据源"
      extra={
        config.data ? (
          <Status kind={config.data.configured ? "good" : "warning"}>
            {config.data.configured ? "已保存Key" : "尚未配置"}
          </Status>
        ) : undefined
      }
    >
      <p className="muted">
        用于皮皮虾图文搜索、推荐、作者及话题列表，采集内容供多个发布渠道复用。密钥仅保存在当前工作空间的系统加密凭据中。
      </p>
      <QueryError
        error={config.error}
        loading={config.loading}
        onRetry={config.reload}
      />
      {!config.data && !config.error ? (
        <LoadingState label="正在读取数据源配置…" />
      ) : null}
      {config.data ? (
        <SecretField
          kind="pipix:tikhub"
          label="TikHub API Key"
          configured={config.data.configured}
          onSaved={config.reload}
        />
      ) : null}
      <small>
        可粘贴原始 Key 或带 Bearer
        前缀的一行令牌；保存不发起外部请求。查询按服务商规则计费，已获取的数据优先复用本地知识库。
      </small>
      <details>
        <summary>单次返回量实测</summary>
        <p className="muted">
          固定关键词与第一页，对比
          count=20、count=1000、page_size=1000。最多请求3次，每份响应先归档，重复测试复用本地响应。
        </p>
        <Field label="测试关键词">
          <input
            aria-label="容量测试关键词"
            value={keyword}
            maxLength={100}
            disabled={busy > 0}
            onChange={(e) => setKeyword(e.target.value)}
          />
        </Field>
        <Button
          disabled={busy > 0 || !config.data?.configured || !keyword.trim()}
          onClick={async () => {
            if (await command("pipix.probeCapacity", { keyword }))
              config.reload();
          }}
        >
          实测单页容量
        </Button>
        {config.data?.capacity ? (
          <>
            <p className="muted">
              {keyword.trim() === config.data.capacity.keyword
                ? "测试结果"
                : "历史结果（与当前输入关键词不同）"}
              {" · "}测试关键词：{config.data.capacity.keyword}
              {" · "}测试时间：{formatTime(config.data.capacity.checkedAt)}
            </p>
            <Notice>
              本次测试最大实际返回 {config.data.capacity.maxObserved}{" "}
              条。该值仅代表上述关键词与接口的观察结果，不是平台全局上限。
            </Notice>
            <table>
              <thead>
                <tr>
                  <th>参数</th>
                  <th>请求值</th>
                  <th>实际返回</th>
                  <th>响应回传参数</th>
                </tr>
              </thead>
              <tbody>
                {config.data.capacity.results.map((r, i) => (
                  <tr key={i}>
                    <td>{r.parameter}</td>
                    <td>{r.requested}</td>
                    <td>{r.returned ?? r.error ?? "未确认"}</td>
                    <td>
                      {r.reflected ? "是" : "未回传"}
                      {r.cached ? " · 本地复用" : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : null}
      </details>
      <small>
        当前文档未声明单次条数参数；参数回传不代表返回量会增加。按实际返回量完整入库，界面分页和采集选择上限不限制入库数量。
      </small>
    </Panel>
  );
}
