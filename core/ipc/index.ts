import { createZhihuAutocareHandlers } from "./zhihu-autocare";
import { createTiebaAutocareHandlers } from "./tieba-autocare";
import { createTiebaParticipationHandlers } from "./tieba-participation";
import { createTiebaAutomationHandlers } from "./tieba-automation";
import { createTiebaTopicsHandlers } from "./tieba-topics";
import { createTiebaInsightsHandlers } from "./tieba-insights";
import { createTiebaPublishingHandlers } from "./tieba-publishing";
import { createTiebaPostStatsHandlers } from "./tieba-post-stats";
import { createPhotoPostHandlers } from "./photo-posts";
import { createResourceCatalogHandlers } from "./resource-catalog";
import { createResourceAnswerHandlers } from "./resource-answers";
import { createResourceDeletionHandlers } from "./resource-deletion";
import { createShareCreationHandlers } from "./share-creation";
import { createResourceLinksHandlers } from "./resource-links";
import { createResourceLandingHandlers } from "./resource-landing";
import { createSmzdmHandlers } from "./smzdm";
import { createWechatHandlers } from "./wechat";
import { createDriveFilesHandlers } from "./drive-files";
import { createDriveBrowserHandlers } from "./drive-browser";
import { createDistributionHandlers } from "./distribution";
import { createPipixHandlers } from "./pipix";
import { createContentSupplyHandlers } from "./content-supply";
import { createZhihuHandlers } from "./zhihu";
import { createZhihuParticipationHandlers } from "./zhihu-participation";
import { createIntelligentOperationsHandlers } from "./intelligent-operations";
import { createBrowserEnvironmentHandlers } from "./browser-environments";
import { createBitBrowserHandlers } from "./bitbrowser";
import { createInsertionHandlers } from "./insertion";
import { createZhidaoHandlers } from "./zhidao";
import { createZhidaoPageDiscoveryHandlers } from "./zhidao-page-discovery";
import { createIpcRegistry } from "./registry";
import type { HandlerServices } from "./types";
import { createWorkspaceHandlers } from "./workspace";
import { createResourcesHandlers } from "./resources";
import { createResourceExportsHandlers } from "./resource-exports";
import { createOperationsHandlers } from "./operations";
import { createAccountHandlers } from "./account";
import { createAccountDeletionHandlers } from "./account-deletion";
import { createSharingHandlers } from "./sharing";
import { createSettingsHandlers } from "./settings";
import { createTrafficHandlers } from "./traffic";
import { createBaiduKeywordHandlers } from "./baidu-keywords";
import { createBaiduDiscoveryHandlers } from "./baidu-discovery";
import { createBaiduResearchHandlers } from "./baidu-research";
import { createWebsiteAccountHandlers } from "./website-accounts";
import { createShareStatisticsHandlers } from "./share-statistics";
import { createAiHandlers } from "./ai";
import { createSearchHandlers } from "./search";
import { createStudioHandlers } from "./studio";
import { createVideoHandlers } from "./video";
import { createMusicHandlers } from "./music";
import { createBilibiliHandlers } from "./bilibili";
import { createBindingsHandlers } from "./bindings";
import { createPublicationHandlers } from "./publication";
import { createCsdnHandlers } from "./csdn";
import { createWeiboHandlers } from "./weibo";
import { createWeiboPostHandlers } from "./weibo-posts";
import { createWeiboStatisticsHandlers } from "./weibo-statistics";
import { createWeiboWorkspaceHandlers } from "./weibo-workspace";

export function createApplicationHandlers(services: HandlerServices) {
  return createIpcRegistry(
    createTiebaAutomationHandlers(services),
    createTiebaTopicsHandlers(services),
    createTiebaInsightsHandlers(services),
    createTiebaPublishingHandlers(services),
    createTiebaPostStatsHandlers(services),
    createTiebaParticipationHandlers(services),
    createTiebaAutocareHandlers(services),
    createZhihuAutocareHandlers(services),
    createContentSupplyHandlers(services),
    createIntelligentOperationsHandlers(services),
    createPhotoPostHandlers(services),
    createBaiduDiscoveryHandlers(services),
    createAccountDeletionHandlers(services),
    createResourceLinksHandlers(services),
    createResourceLandingHandlers(services),
    createResourceCatalogHandlers(services),
    createResourceDeletionHandlers(services),
    createShareCreationHandlers(services),
    createSmzdmHandlers(services),
    createWechatHandlers(services),
    createDriveFilesHandlers(services),
    createDriveBrowserHandlers(services),
    createDistributionHandlers(services),
    createZhihuHandlers(services),
    createZhihuParticipationHandlers(services),
    createPipixHandlers(services),
    createBrowserEnvironmentHandlers(services),
    createBitBrowserHandlers(services),
    createResourceAnswerHandlers(services),
    createWeiboPostHandlers(services),
    createWeiboWorkspaceHandlers(services),
    createWeiboStatisticsHandlers(services),
    createWeiboHandlers(services),
    createCsdnHandlers(services),
    createZhidaoHandlers(services),
    createZhidaoPageDiscoveryHandlers(services),
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
    createVideoHandlers(services),
    createMusicHandlers(services),
    createBilibiliHandlers(services),
    createBindingsHandlers(services),
    createPublicationHandlers(services),
  );
}
