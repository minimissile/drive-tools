import { createInsertionHandlers } from "./insertion";
import { createZhidaoHandlers } from "./zhidao";
import { createIpcRegistry } from "./registry";
import type { HandlerServices } from "./types";
import { createWorkspaceHandlers } from "./workspace";
import { createResourcesHandlers } from "./resources";
import { createResourceExportsHandlers } from "./resource-exports";
import { createOperationsHandlers } from "./operations";
import { createAccountHandlers } from "./account";
import { createSharingHandlers } from "./sharing";
import { createSettingsHandlers } from "./settings";
import { createTrafficHandlers } from "./traffic";
import { createBaiduKeywordHandlers } from "./baidu-keywords";
import { createBaiduResearchHandlers } from "./baidu-research";
import { createWebsiteAccountHandlers } from "./website-accounts";
import { createShareStatisticsHandlers } from "./share-statistics";
import { createAiHandlers } from "./ai";
import { createSearchHandlers } from "./search";
import { createStudioHandlers } from "./studio";
import { createBindingsHandlers } from "./bindings";
import { createPublicationHandlers } from "./publication";

export function createApplicationHandlers(services: HandlerServices) {
  return createIpcRegistry(
    createZhidaoHandlers(services),
    createWorkspaceHandlers(services),
    createResourcesHandlers(services),
    createResourceExportsHandlers(services),
    createOperationsHandlers(services),
    createInsertionHandlers(services),
    createAccountHandlers(services),
    createSharingHandlers(services),
    createSettingsHandlers(services),
    createTrafficHandlers(services),
    createBaiduKeywordHandlers(services),
    createBaiduResearchHandlers(services),
    createWebsiteAccountHandlers(services),
    createShareStatisticsHandlers(services),
    createAiHandlers(services),
    createSearchHandlers(services),
    createStudioHandlers(services),
    createBindingsHandlers(services),
    createPublicationHandlers(services),
  );
}
