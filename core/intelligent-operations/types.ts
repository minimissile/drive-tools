import type { z } from "zod";
import type { operationsChannelPolicy } from "../../shared/intelligent-operations";
import type { Database } from "../database";
import type { Repository } from "../repository";
import type { WebsiteAccounts } from "../website-accounts";
import type { BrowserEnvironments } from "../browser-environments";
import type { ZhihuOperations } from "../zhihu/service";
import type { WeiboPosts } from "../weibo/posts";
import type { WeiboStatistics } from "../weibo/statistics";
import type { AiService } from "../ai";
export type OperationsChannelPolicy = z.output<typeof operationsChannelPolicy>;
export interface IntelligentOperationsDependencies {
  db: Database;
  repo: Repository;
  accounts: WebsiteAccounts;
  environments: BrowserEnvironments;
  zhihu: ZhihuOperations;
  weiboPosts: WeiboPosts;
  weiboStatistics: WeiboStatistics;
  ai: AiService;
  dataPath: string;
  changed(): void;
  clock?: () => number;
}
