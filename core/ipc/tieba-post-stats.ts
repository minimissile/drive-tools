import {
  tiebaPostStatsDiscoverSchema,
  tiebaPostStatsImportSchema,
  tiebaPostStatsRefreshSchema,
} from "../../shared/tieba-post-stats";
import type { TiebaPostStats } from "../tieba-post-stats/service";
export function createTiebaPostStatsHandlers({
  tiebaPostStats,
}: {
  tiebaPostStats: TiebaPostStats;
}) {
  return {
    "tieba.postStats.snapshot": () => tiebaPostStats.snapshot(),
    "tieba.postStats.refresh": (raw: unknown) =>
      tiebaPostStats.refresh(tiebaPostStatsRefreshSchema.parse(raw)),
    "tieba.postStats.import": (raw: unknown) =>
      tiebaPostStats.importThread(tiebaPostStatsImportSchema.parse(raw)),
    "tieba.postStats.discover": (raw: unknown) =>
      tiebaPostStats.discover(tiebaPostStatsDiscoverSchema.parse(raw)),
  };
}
