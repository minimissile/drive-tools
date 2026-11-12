import type { TiebaForumExposure } from "../../shared/tieba-analysis";

const rate = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });

export function formatForumExposure(
  exposure: TiebaForumExposure | null | undefined,
) {
  return exposure ? `${rate.format(exposure.hourly)} 次/小时` : "样本不足";
}

export function TiebaPotentialFormula() {
  return (
    <details className="tieba-potential-formula muted">
      <summary>潜力值与曝光潜力怎么算</summary>
      <p>同期按发帖时长分组，分界为 2、8、24、48、72 小时和 7、14 天。</p>
      <p>
        浏览速度 = 累计浏览量 ÷ max（发帖时长，0.5
        小时）。同吧同期按浏览速度排名，相同速度取并列末位。
      </p>
      <p>
        潜力值 = 向下取整［100 ×（样本数 − 名次）÷（样本数 − 1）］。至少需要 4
        篇含浏览量的同期帖子，分数范围为 0–100。
      </p>
      <p>
        用户查询用所在吧的公开帖子比较。资源发现用去重后的资源帖比较，达到监控分数且至少有
        10 次浏览才进入潜力队列。
      </p>
      <p>
        贴吧曝光潜力 = 近 48 小时公开样本的浏览速度中位数。至少需要 4
        篇，单位为次/小时，可用于比较贴吧的典型曝光速度。
      </p>
    </details>
  );
}
