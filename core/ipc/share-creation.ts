import { z } from "zod";
import type { HandlerMap, HandlerServices } from "./types";
import { AppError } from "../errors";
import { parseShare } from "../links";
import { readSharePassphrase, saveSharePassphrase } from "../share-passphrases";

export function createShareCreationHandlers(
  services: Pick<
    HandlerServices,
    "shareCreation" | "baiduDiscoveryQuestions" | "repo" | "secrets" | "changed"
  >,
) {
  const copy = z.object({ copyId: z.string().min(1).max(100) });
  const target = copy.extend({ operationId: z.string().uuid().optional() });
  const scopeFor = async (input: z.infer<typeof target>) => {
    if (input.operationId)
      return services.shareCreation.passphraseScope(
        input.copyId,
        input.operationId,
      );
    const saved = services.repo.getCopy(input.copyId);
    const account = services.repo.getAccount(saved.accountId);
    if (!saved.shareId || !saved.shareUrl || !saved.shareOwnerUid)
      throw new AppError(
        "SHARE_NOT_READY",
        "尚未保存本人分享，请先完成分享创建与核对。",
      );
    if (saved.shareOwnerUid !== account.uid)
      throw new AppError(
        "ACCOUNT_UID_MISMATCH",
        "此口令属于原网盘账号，请切回原账号后查看。",
      );
    const code = (await services.secrets.get(`share:${saved.id}`)) || "";
    const parsed = parseShare(saved.shareUrl, code);
    if (parsed.provider !== account.provider)
      throw new AppError("INVALID_LINK", "本人分享与网盘账号类型不一致。");
    return {
      key: `share-passphrase:copy:${saved.id}`,
      accountId: account.id,
      provider: account.provider,
      shareId: saved.shareId,
      ownerUid: saved.shareOwnerUid,
      url: parsed.url,
      code: parsed.code,
    };
  };
  const sameScope = (a: unknown, b: unknown) =>
    JSON.stringify(a) === JSON.stringify(b);
  const readFor = async (input: z.infer<typeof target>) => {
    const scope = await scopeFor(input);
    const saved = await readSharePassphrase(services.secrets, scope);
    if (!sameScope(scope, await scopeFor(input)))
      throw new AppError(
        "SHARE_CHANGED",
        "读取期间分享发生变化，请查看当前分享后重试。",
      );
    return saved;
  };
  return {
    "share.passphrase": async (input) => readFor(target.parse(input)),
    "share.savePassphrase": async (input) => {
      const value = target
        .extend({ text: z.string().min(1).max(8000) })
        .parse(input);
      const scope = await scopeFor(value);
      const saved = await saveSharePassphrase(
        services.secrets,
        scope,
        value.text,
      );
      // Encryption may be asynchronous. Do not acknowledge a result against a
      // share/account that changed while it was being saved.
      const current = await scopeFor(value);
      if (!sameScope(current, scope))
        throw new AppError(
          "SHARE_CHANGED",
          "保存期间分享发生变化，请核对当前分享后重试。",
        );
      services.changed();
      return saved;
    },
    "share.copyPassphrase": async (input) => {
      const value = await readFor(target.parse(input));
      if (!value)
        throw new AppError(
          "PASSPHRASE_NOT_SAVED",
          "尚未获取当前分享的中文口令，请先保存 App 的完整官方分享内容。",
        );
      return { text: value.text };
    },
    "share.creationOptions": (input) =>
      services.shareCreation.options(copy.parse(input).copyId),
    "share.creationResult": (input) =>
      services.shareCreation.result(
        z.object({ operationId: z.string().uuid() }).parse(input).operationId,
      ),
    "share.create": (input) => {
      if (services.baiduDiscoveryQuestions.isBusy)
        throw new AppError(
          "QUESTION_IMPORT_BUSY",
          "正在为长尾词创建分享，请等待本轮完成后再单独建链。",
        );
      return services.shareCreation.create(
        copy
          .extend({
            operationId: z.string().uuid(),
            expiresInDays: z.number().int().min(0).max(3650),
            extractionCode: z.string().trim().max(30).optional(),
          })
          .parse(input),
      );
    },
    "share.recheckCreation": (input) =>
      services.shareCreation.recheck(
        z.object({ operationId: z.string().uuid() }).parse(input).operationId,
      ),
    "share.resolveCreation": (input) => {
      const value = z
        .object({
          operationId: z.string().uuid(),
          outcome: z.enum(["not_created", "handled"]),
        })
        .parse(input);
      return services.shareCreation.resolve(value.operationId, value.outcome);
    },
  } satisfies HandlerMap;
}
