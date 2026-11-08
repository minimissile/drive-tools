import { errors, type Page } from "playwright-core";
import { AppError, safeMessage } from "../errors";
import {
  tiebaForumKeywordSchema,
  type TiebaForumDiscoveryResult,
} from "../../shared/tieba-forum-discovery";
import {
  assertTiebaAccount,
  assertTiebaViewer,
  withTiebaBusinessPage,
} from "./browser-runtime";
import type { TiebaAutocareBrowser, TiebaBrowserProfile } from "./types";
import {
  parseTiebaForumDiscovery,
  parseTiebaForumActivity,
  tiebaForumDiscoveryPageScript,
  tiebaForumActivityScript,
  tiebaForumDiscoverySearchUrl,
  tiebaDiscoveryLimit,
  type TiebaForumDiscoverySnapshot,
  type TiebaForumActivitySnapshot,
} from "./forum-discovery-page";
export function tiebaForumDiscoveryBrowser(
  profile: TiebaBrowserProfile,
  options: { pageTimeoutMs?: number } = {},
): Pick<TiebaAutocareBrowser, "findForums"> {
  const wait = async (page: Page, script: string, ready: string) => {
    try {
      await page.waitForFunction(
        `(()=>{const s=${script};return s.challenge||s.login||(${ready});})()`,
        undefined,
        { timeout: options.pageTimeoutMs ?? 8000 },
      );
    } catch (error) {
      if (!(error instanceof errors.TimeoutError)) throw error;
    }
  };
  return {
    findForums(account, uid, input) {
      assertTiebaAccount(account, uid);
      const keyword = tiebaForumKeywordSchema.parse(input);
      return profile(account, async (context) => {
        await assertTiebaViewer(context, uid);
        return withTiebaBusinessPage(context, async (page, go) => {
          await go(tiebaForumDiscoverySearchUrl(keyword));
          await wait(
            page,
            tiebaForumDiscoveryPageScript,
            "s.searchFailed||(s.searchActive&&(s.searchRows.length||s.searchEmpty))",
          );
          const search = parseTiebaForumDiscovery(
            await page.evaluate<TiebaForumDiscoverySnapshot>(
              tiebaForumDiscoveryPageScript,
            ),
            uid,
            keyword,
          );
          const items = [];
          let stopped = false,
            failed = 0;
          for (const item of search.items.slice(0, tiebaDiscoveryLimit)) {
            if (stopped) {
              items.push({
                ...item,
                message: "前一页面要求官网验证，已停止后续首页采样。",
              });
              continue;
            }
            try {
              await go(item.url);
              await wait(
                page,
                tiebaForumActivityScript,
                "s.forum&&s.threadsRecognized&&(s.memberText||s.postText||s.footerText)",
              );
              const s = await page.evaluate<TiebaForumActivitySnapshot>(
                tiebaForumActivityScript,
              );
              items.push(parseTiebaForumActivity(s, uid, item));
            } catch (error) {
              if (
                error instanceof AppError &&
                /IDENTITY|LOGIN|UID/.test(error.code)
              )
                throw error;
              failed++;
              items.push({
                ...item,
                message: `首页采样未完成：${safeMessage(error)}`,
                checkedAt: new Date().toISOString(),
              });
              if (
                error instanceof AppError &&
                /VERIF|CAPTCHA|RATE_LIMIT/.test(error.code)
              )
                stopped = true;
            }
          }
          await assertTiebaViewer(context, uid);
          const result: TiebaForumDiscoveryResult = {
            accountId: account.id,
            keyword,
            items,
            checkedAt: new Date().toISOString(),
            truncated: search.truncated || failed > 0,
            message: `仅返回官网本次找吧页最多${tiebaDiscoveryLimit}个候选，每吧采样首页最多30行；不代表全站完整名单或长期活跃程度。${failed ? `其中${failed}个首页读取未完成，保留已核实结果。` : ""}`,
          };
          return result;
        });
      });
    },
  };
}
