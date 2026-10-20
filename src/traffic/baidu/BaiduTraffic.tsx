import { useEffect, useState } from "react";
import { z } from "zod";
import {
  baiduTools,
  type BaiduTool,
  type BaiduResearchInput,
} from "../../../shared/baidu-research";
import { useAppActions, useAppData, useAppNavigation } from "../../state";
import { useLocalDraft } from "../../hooks/useLocalDraft";
import { useIpcQuery } from "../../api/useIpcQuery";
import { Button, Field, Notice, Panel } from "../../ui/primitives";
import { Loading, LoadingState } from "../../ui/DataState";
import { QueryError } from "../../ui/QueryError";
import { Select } from "../../ui/Select";
import { Tabs, TabList, TabPanel } from "../../ui/Tabs";
import { BaiduRegions } from "./BaiduRegions";
import { BaiduResearchResults } from "./BaiduResearchResults";
import { useBaiduResearch } from "./useBaiduResearch";
import { useBaiduGroupFile } from "./useBaiduGroupFile";
import { splitBaiduWords, treeOptions } from "./options";
import BaiduKeywords from "./BaiduKeywords";
import "./baidu-keywords.css";
import { formSchema, defaultForm } from "./research-draft";
import { BaiduGroupingForm } from "./BaiduGroupingForm";
import { BaiduIndustryForm } from "./BaiduIndustryForm";
import { BaiduRankingForm } from "./BaiduRankingForm";
import { BaiduKeywordListForm } from "./BaiduKeywordListForm";

type Transfer = { id: number; words: string[] };
export default function BaiduTraffic({
  onOpenKnowledge,
}: {
  onOpenKnowledge(): void;
}) {
  const { data } = useAppData();
  return (
    <Workspace
      key={data!.dataPath}
      workspace={data!.dataPath}
      onOpenKnowledge={onOpenKnowledge}
    />
  );
}
function Workspace({
  workspace,
  onOpenKnowledge,
}: {
  workspace: string;
  onOpenKnowledge(): void;
}) {
  const [tool, setTool] = useState<BaiduTool>("keyword"),
    [seedTransfer, setSeedTransfer] = useState<Transfer | null>(null),
    [flowTransfer, setFlowTransfer] = useState<Transfer | null>(null);
  const expand = (words: string[]) => {
    setSeedTransfer({ id: Date.now(), words });
    setTool("keyword");
  };
  const flow = (words: string[]) => {
    setFlowTransfer({ id: Date.now(), words });
    setTool("flow");
  };
  return (
    <div className="baidu-traffic">
      <Tabs<BaiduTool> value={tool} onChange={setTool}>
        <TabList label="百度营销找流量工具" items={baiduTools} />
        <TabPanel value={tool}>
          {tool === "keyword" ? (
            <BaiduKeywords
              incomingSeeds={seedTransfer}
              onOpenKnowledge={onOpenKnowledge}
            />
          ) : (
            <ResearchWorkspace
              key={`${workspace}:${tool}`}
              workspace={workspace}
              tool={tool}
              incomingWords={flowTransfer}
              onExpand={expand}
              onFlow={flow}
              onOpenKnowledge={onOpenKnowledge}
            />
          )}
        </TabPanel>
      </Tabs>
    </div>
  );
}
function ResearchWorkspace({
  workspace,
  tool,
  incomingWords,
  onExpand,
  onFlow,
  onOpenKnowledge,
}: {
  workspace: string;
  tool: Exclude<BaiduTool, "keyword">;
  incomingWords: Transfer | null;
  onExpand(words: string[]): void;
  onFlow(words: string[]): void;
  onOpenKnowledge(): void;
}) {
  const connection = useLocalDraft(
    `panxu-baidu-research-account:${workspace}`,
    { accountId: "" },
    (v) => z.object({ accountId: z.string() }).parse(v),
  );
  const accounts = useIpcQuery("websiteAccounts.list", undefined, {
    keepPrevious: true,
    refreshInterval: 2500,
  });
  const choices = (accounts.data ?? []).filter(
      (a) => a.provider === "baidu-marketing",
    ),
    account =
      choices.find((a) => a.id === connection.value.accountId) ??
      choices.find((a) => a.status === "connected") ??
      choices[0];
  const { navigate } = useAppNavigation();
  return (
    <div className="baidu-keywords-workspace">
      <Panel title={baiduTools.find((t) => t[0] === tool)![1]}>
        <div className="baidu-keyword-connection">
          <Field label="百度营销账号">
            <Select
              aria-label="百度流量工具账号"
              value={account?.id ?? ""}
              items={
                choices.length
                  ? choices.map((a) => ({
                      value: a.id,
                      label: `${a.alias}${a.status === "connected" ? "" : " · 需登录"}`,
                    }))
                  : [{ value: "", label: "请先添加网站账号" }]
              }
              onValueChange={(accountId) => connection.update({ accountId })}
            />
          </Field>
          <Button quiet onClick={() => navigate("website-accounts")}>
            管理网站账号
          </Button>
        </div>
        <QueryError
          error={accounts.error}
          loading={accounts.loading}
          onRetry={accounts.reload}
          title="无法读取百度账号"
        />
        {accounts.loading && !accounts.data ? (
          <Loading label="正在读取网站账号…" />
        ) : !account ? (
          <Notice>请先在账号管理登录百度营销。</Notice>
        ) : (
          <ResearchTool
            key={account.id}
            workspace={workspace}
            tool={tool}
            accountId={account.id}
            uid={account.uid}
            connected={account.status === "connected"}
            incomingWords={incomingWords}
            onExpand={onExpand}
            onFlow={onFlow}
            onOpenKnowledge={onOpenKnowledge}
          />
        )}
      </Panel>
    </div>
  );
}
function ResearchTool({
  workspace,
  tool,
  accountId,
  uid,
  connected,
  incomingWords,
  onExpand,
  onFlow,
  onOpenKnowledge,
}: {
  workspace: string;
  tool: Exclude<BaiduTool, "keyword">;
  accountId: string;
  uid: string | null;
  connected: boolean;
  incomingWords: Transfer | null;
  onExpand(words: string[]): void;
  onFlow(words: string[]): void;
  onOpenKnowledge(): void;
}) {
  const { command, notify } = useAppActions();
  const draft = useLocalDraft(
    `panxu-baidu-research-form-v1:${workspace}:${accountId}:${tool}`,
    defaultForm,
    (v) => formSchema.parse(v),
  );
  const d = draft.value,
    op: BaiduResearchInput["operation"] =
      tool === "ranking"
        ? "rank"
        : tool === "flow"
          ? "flow"
          : tool === "mass"
            ? "massList"
            : tool === "grouping"
              ? "groupList"
              : d.industryView === "trend"
                ? "industryTrend"
                : "industryWords";
  const model = useBaiduResearch(accountId, op, uid),
    businesses = useBaiduResearch(accountId, "businesses", uid),
    industries = useBaiduResearch(accountId, "industryTree", uid),
    templates = useBaiduResearch(accountId, "templates", uid);
  const readyDate = useBaiduResearch(accountId, "rankDate", uid);
  const industryChildren = useBaiduResearch(accountId, "industryChildren", uid);
  const businessOptions = treeOptions(businesses.result?.data),
    industryOptions = [
      ...treeOptions(industries.result?.data, "industry"),
      ...(d.category === "business" && industryChildren.result
        ? treeOptions(industryChildren.result.data, "industry").map((o) => {
            const path = [
              ...industryChildren.result!.input.trades.slice(0, 2),
              ...o.path,
            ];
            return {
              ...o,
              path,
              value: path.join(" / "),
              label: path.join(" / "),
            };
          })
        : []),
    ];
  const groupFile = useBaiduGroupFile(workspace, accountId);
  const { file, uploaded, uploading, error: uploadError } = groupFile;
  const [submitted, setSubmitted] = useState(""),
    [submittedForm, setSubmittedForm] = useState(""),
    [remotePage, setRemotePage] = useState(1);
  const busy =
    model.pending ||
    (tool === "grouping" && groupFile.busy) ||
    businesses.pending ||
    industries.pending ||
    industryChildren.pending ||
    templates.pending;
  useEffect(() => {
    if (tool === "flow" && incomingWords)
      draft.update({ words: incomingWords.words.join("\n") });
  }, [incomingWords?.id, tool]);
  const dimensions = d.dimensions
    .filter((x) => x.roots.trim())
    .map((x) => ({
      type: x.type as 1 | 2 | 3 | 4,
      dimensionName: x.dimensionName,
      keywordRootList: splitBaiduWords(x.roots),
    }));
  const input: Partial<BaiduResearchInput> = {
    words: splitBaiduWords(d.words),
    negativeWords: splitBaiduWords(d.negative),
    regions: d.regions,
    device: d.device as 0 | 1 | 2,
    removeDuplicate: d.removeDuplicate,
    regionExtend: d.regionExtend,
    price: d.price ? Number(d.price) : undefined,
    match: d.match as BaiduResearchInput["match"],
    businessId: d.businessId || undefined,
    tab: d.rankTab as BaiduResearchInput["tab"],
    dimensions,
    outputUngroupedWords: d.outputUngroupedWords,
    templateName: d.templateName || undefined,
    ...uploaded,
    trades: d.trade ? d.trade.split(" / ") : [],
    category: d.category as BaiduResearchInput["category"],
    industryDevice: d.industryDevice as BaiduResearchInput["industryDevice"],
    startDate: (d.startDate as `${number}-${number}-${number}`) || undefined,
    endDate: (d.endDate as `${number}-${number}-${number}`) || undefined,
    wordType: d.wordType as BaiduResearchInput["wordType"],
    geoGran: d.geoGran as BaiduResearchInput["geoGran"],
    geoTarget: splitBaiduWords(d.geoTarget),
    page: remotePage,
    pageSize: 100,
  };
  const run = async (operation = op, page = 1) => {
    setRemotePage(page);
    await model.run({ ...input, operation, page });
  };
  const create = async (
    operation: "massCreate" | "groupCreate" | "templateCreate",
  ) => {
    const result = await model.run({ ...input, operation }, false);
    if (result) {
      setSubmitted(
        operation === "templateCreate"
          ? "分组模板已保存，请读取模板列表查看。"
          : "任务已提交。处理完成后点击“读取任务列表”查看状态，请勿重复提交。",
      );
      if (operation !== "templateCreate") setSubmittedForm(JSON.stringify(d));
      notify(
        operation === "templateCreate" ? "分组模板已保存" : "百度任务已提交",
        result.warning ? "warning" : "success",
      );
      if (result.warning) notify(result.warning, "warning");
    }
  };
  const canSubmit = connected && !busy,
    operationError =
      model.error ||
      uploadError ||
      businesses.error ||
      industries.error ||
      industryChildren.error ||
      templates.error ||
      readyDate.error;
  return (
    <div className="baidu-research-form">
      <div className="row spread">
        <p className="muted">
          {
            {
              ranking: "从高消费、高转化和热搜榜中发现需求，选词后继续拓词。",
              flow: "批量查询指定关键词的搜索量、指导价和预估指标。",
              mass: "提交海量拓词任务，稍后手动读取状态与下载结果。",
              grouping: "上传关键词表格，按多个维度分组并复用模板。",
              industry:
                "查看行业或推广业务的搜索趋势，以及热搜词、新增词和激增词。",
            }[tool]
          }
        </p>
        <Button
          quiet
          disabled={!accountId || busy}
          onClick={() =>
            void command("baiduResearch.open", { accountId, tool })
          }
        >
          打开对应官方工具
        </Button>
      </div>
      {!connected ? (
        <Notice>请在账号管理完成百度营销登录后，再手动查询。</Notice>
      ) : null}
      {tool === "ranking" ? (
        <BaiduRankingForm
          draft={draft}
          canSubmit={canSubmit}
          businessOptions={businessOptions}
          businesses={businesses}
          readyDate={readyDate}
        />
      ) : null}
      {tool === "flow" || tool === "mass" ? (
        <BaiduKeywordListForm draft={draft} tool={tool} />
      ) : null}
      {["ranking", "flow", "mass"].includes(tool) ? (
        <BaiduRegions
          value={d.regions}
          disabled={busy}
          onChange={(regions) => draft.update({ regions })}
        />
      ) : null}
      {tool === "mass" || tool === "ranking" ? (
        <div className="row wrap">
          <label>
            <input
              type="checkbox"
              checked={d.removeDuplicate}
              onChange={(e) =>
                draft.update({ removeDuplicate: e.target.checked })
              }
            />{" "}
            不包含账户已购词
          </label>
          {tool === "mass" ? (
            <label>
              <input
                type="checkbox"
                checked={d.regionExtend}
                onChange={(e) =>
                  draft.update({ regionExtend: e.target.checked })
                }
              />{" "}
              包含地域词
            </label>
          ) : null}
        </div>
      ) : null}
      {tool === "grouping" ? (
        <BaiduGroupingForm
          draft={draft}
          groupFile={groupFile}
          canSubmit={canSubmit}
          dimensionsCount={dimensions.length}
          templates={templates}
          model={model}
          onSaveTemplate={() => create("templateCreate")}
        />
      ) : null}
      {tool === "industry" ? (
        <BaiduIndustryForm
          draft={draft}
          canSubmit={canSubmit}
          industryOptions={industryOptions}
          industries={industries}
          industryChildren={industryChildren}
        />
      ) : null}
      <div className="row wrap">
        {tool === "mass" || tool === "grouping" ? (
          <>
            <Button
              primary
              disabled={
                !canSubmit ||
                submittedForm === JSON.stringify(d) ||
                (tool === "grouping"
                  ? !uploaded
                  : !d.words.trim() ||
                    Number(
                      (
                        model.result?.data as
                          { totalRunningTaskCount?: number } | undefined
                      )?.totalRunningTaskCount ?? 0,
                    ) >= 5)
              }
              onClick={() =>
                void create(tool === "mass" ? "massCreate" : "groupCreate")
              }
            >
              {model.pending ? "正在提交…" : "提交百度任务"}
            </Button>
            <Button disabled={!canSubmit} onClick={() => void run()}>
              读取任务列表
            </Button>
          </>
        ) : (
          <Button primary disabled={!canSubmit} onClick={() => void run()}>
            {model.pending ? "正在查询…" : "查询百度数据"}
          </Button>
        )}
      </div>
      {submitted ? <Notice>{submitted}</Notice> : null}
      {draft.error ? <Notice warning>{draft.error}</Notice> : null}
      {operationError ? <Notice warning>{operationError}</Notice> : null}
      <hr />
      <div className="row spread">
        <h3>
          {tool === "mass" || tool === "grouping" ? "任务列表" : "查询结果"}
        </h3>
        <Button
          quiet
          disabled={model.latest.loading}
          onClick={model.latest.reload}
        >
          重读本地记录
        </Button>
      </div>
      <QueryError
        error={model.latest.error}
        loading={model.latest.loading}
        onRetry={model.latest.reload}
        title="无法读取本地工具记录"
      />
      {(model.latest.loading || model.pending) && !model.result ? (
        <LoadingState
          label={model.pending ? "正在请求百度…" : "正在读取本地记录…"}
        />
      ) : null}
      {model.pending && model.result ? (
        <Loading label="正在读取，保留上次成功结果…" />
      ) : null}
      {model.result ? (
        <>
          <BaiduResearchResults
            key={model.result.id}
            result={model.result}
            onExpand={onExpand}
            onFlow={onFlow}
            onOpenKnowledge={onOpenKnowledge}
          />
          {["rank", "flow", "massList", "groupList"].includes(op) &&
          model.result.total > model.result.rows.length ? (
            <div className="row wrap">
              <Button
                disabled={!canSubmit || model.result.input.page <= 1}
                onClick={() => void run(op, model.result!.input.page - 1)}
              >
                读取上一页
              </Button>
              <span>百度第{model.result.input.page}页，每页100条</span>
              <Button
                disabled={
                  !canSubmit ||
                  model.result.input.page * 100 >= model.result.total
                }
                onClick={() => void run(op, model.result!.input.page + 1)}
              >
                读取下一页
              </Button>
            </div>
          ) : null}
        </>
      ) : !model.latest.loading && !model.pending && !model.latest.error ? (
        <p className="muted">
          尚无本地成功记录。填写条件后手动读取百度数据，切换工具和页面不会自动发起外部查询。
        </p>
      ) : null}
    </div>
  );
}
