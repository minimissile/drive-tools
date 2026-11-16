import { tiebaPostExposure } from "../../shared/tieba-analysis";

const number = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });

export function PostExposureCell({
  views,
  publishedAt,
  observedAt,
  unit = "hour",
}: {
  views: number | null;
  publishedAt: string | null;
  observedAt: number;
  unit?: "hour" | "day";
}) {
  const hourly = tiebaPostExposure(views, publishedAt, observedAt);
  const rate = hourly === null ? null : hourly * (unit === "day" ? 24 : 1);
  return (
    <td className="tieba-post-exposure">
      {rate === null ? (
        <span className="muted">
          {views === null
            ? "缺浏览量"
            : publishedAt
              ? "时间异常"
              : "缺发布时间"}
        </span>
      ) : (
        <>
          <strong>
            {rate > 0 && rate < 0.01 ? "<0.01" : number.format(rate)}
          </strong>
          <small className="muted">{unit === "day" ? "次/天" : "次/小时"}</small>
        </>
      )}
    </td>
  );
}
