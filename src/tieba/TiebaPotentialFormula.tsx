import {
  tiebaForumExposureHours,
  tiebaForumExposureSampleLimit,
  type TiebaForumExposure,
} from "../../shared/tieba-analysis";
import {
  oldTrafficMinimumAgeDays,
  oldTrafficObservationDays,
  pendingObservationMultiplier,
  recentGrowthMaxReadingHours,
  tiebaDiscoveryRulesSchema,
  type TiebaDiscoveryRules,
} from "../../shared/tieba-resource-discovery";
import type { useIpcQuery } from "../api/useIpcQuery";
import { Loading } from "../ui/primitives";
import { QueryError } from "../ui/QueryError";

const rate = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });
const ruleValue = new Intl.NumberFormat("zh-CN", { maximumSignificantDigits: 16 });

export function formatForumExposure(
  exposure: TiebaForumExposure | null | undefined,
  unit: "hour" | "day" = "hour",
) {
  if (!exposure) return "样本不足";
  return unit === "day"
    ? `${rate.format(exposure.hourly * 24)} 次/天`
    : `${rate.format(exposure.hourly)} 次/小时`;
}

export function TiebaPotentialFormula({
  open,
  onOpenChange,
  snapshot,
  showQueryError,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  snapshot: Pick<ReturnType<typeof useIpcQuery<"tieba.discovery.snapshot">>, "data" | "error" | "loading" | "reload">;
  showQueryError: boolean;
}) {
  const rules = open && snapshot.data
    ? tiebaDiscoveryRulesSchema.safeParse(snapshot.data.rules).data
    : undefined;
  return (
    <details
      className="tieba-potential-formula muted"
      open={open}
      onToggle={({ currentTarget }) => onOpenChange(currentTarget.open)}
    >
      <summary>规则说明</summary>
      {open ? (
        <div className="tieba-rule-details">
          {rules && <DiscoveryRuleDetails rules={rules} />}
          {!rules && snapshot.loading && <Loading label="正在读取已保存的发现规则…" />}
          {!rules && showQueryError && (
            <QueryError error={snapshot.error} loading={snapshot.loading} onRetry={snapshot.reload} />
          )}
          {!rules && snapshot.data && !snapshot.loading && !snapshot.error && (
            <p>当前后台未返回完整的发现规则。可点击「应用更新并重启」后再查看。</p>
          )}
          <dl>
            <dt>帖子曝光潜力</dt>
            <dd>
              读取时的累计浏览量 ÷ 发帖到此次读取经过的时间。发帖不足半小时，按半小时算。
              按用户查询显示次/小时，按贴吧查询和资源发现显示次/天。
            </dd>
            <dt>贴吧曝光潜力</dt>
            <dd>
              取近 {tiebaForumExposureHours} 小时内有效帖子的浏览速度，排序后取中位数，至少需要 4 篇。
              按贴吧查询用当前页样本，资源发现用本批读到的最新 {tiebaForumExposureSampleLimit} 篇以内的样本，单位都是次/天。
            </dd>
          </dl>
        </div>
      ) : null}
    </details>
  );
}

function DiscoveryRuleDetails({ rules }: { rules: TiebaDiscoveryRules }) {
  const monitoringDaily = rules.minHourlyViews * 24;
  const {
    pendingObservationHours, lookbackHours, trafficThreshold, recentGrowthMinDailyViews,
    oldTrafficMinTotalViews, oldTrafficMinLifetimeDailyViews, oldTrafficMinViews, oldResourceCheckEnabled,
  } = rules;
  return (
    <>
      <p>以下门槛来自「发现设置」，以已保存的数值为准。</p>
      <dl>
        <dt>待观察</dt>
        <dd>
          发帖未满 <strong>{ruleValue.format(pendingObservationHours)} 小时</strong>，
          累计浏览不足 {ruleValue.format(trafficThreshold)} 次，且曝光潜力达到
          <strong> {ruleValue.format(monitoringDaily * pendingObservationMultiplier)} 次/天</strong>（监控门槛的 {pendingObservationMultiplier} 倍），先进入「待观察」。
          到期后用最新浏览量重新计算。
        </dd>
        <dt>潜力帖</dt>
        <dd>
          <p>
            发帖满 {ruleValue.format(pendingObservationHours)} 小时、且仍在 {ruleValue.format(lookbackHours)} 小时观察期内，
            累计浏览不足 {ruleValue.format(trafficThreshold)} 次，曝光潜力达到
            <strong> {ruleValue.format(monitoringDaily)} 次/天</strong>，可进入「潜力帖」。
          </p>
          {lookbackHours < oldTrafficMinimumAgeDays * 24 ? (
            <p>
              超过 {ruleValue.format(lookbackHours)} 小时、未满 {oldTrafficMinimumAgeDays} 天，
              累计浏览不足 {ruleValue.format(trafficThreshold)} 次，改看最近的增长。
              取相隔 30 分钟至 {recentGrowthMaxReadingHours} 小时的两次读数，用新增浏览量 ÷ 间隔天数，
              达到 <strong>{ruleValue.format(recentGrowthMinDailyViews)} 次/天</strong>即可进入「潜力帖」。
            </p>
          ) : null}
          <p>可用「有实测增长」筛选，查看因近期增长入库或复查确认上涨的帖子。</p>
        </dd>
        <dt>流量帖</dt>
        <dd>
          <p><strong>累计高流量</strong>　累计浏览达到 <strong>{ruleValue.format(trafficThreshold)} 次</strong>，可直接入库。</p>
          <p>
            <strong>老帖初筛</strong>　发帖满 {oldTrafficMinimumAgeDays} 天，
            累计浏览达到 <strong>{ruleValue.format(oldTrafficMinTotalViews)} 次</strong>，
            且累计浏览 ÷ 发帖以来的实际天数达到 <strong>{ruleValue.format(oldTrafficMinLifetimeDailyViews)} 次/天</strong>。
            {oldResourceCheckEnabled
              ? " 当前已开启资源校验，还要在标题、正文或最近最多 20 条回复里命中网盘、云盘、资源、链接、提取码、口令、百度、夸克或 //pan. 中任一关键词；关键词以文本匹配，不要求能解析出有效分享链接。"
              : " 当前资源校验已关闭，通过流量初筛即可收录。"}
          </p>
          <p>
            <strong>老帖实测达标</strong>　两次读数至少相隔 {oldTrafficObservationDays} 天，新增浏览量 ÷ 间隔天数
            超过 <strong>{ruleValue.format(oldTrafficMinViews)} 次/天</strong>即可在「实测达标」中查看。
            连续两段都达标会标记为「持续增长」。
          </p>
          <p>手动入库时，满 {oldTrafficMinimumAgeDays} 天的帖子先判断能否收录为老帖，再判断累计高流量门槛。</p>
        </dd>
      </dl>
    </>
  );
}
