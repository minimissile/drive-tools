import { randomInt } from "node:crypto";
import {
  type KeyboardSkinItem,
  type KeyboardSkinSample,
} from "../../shared/keyboard-skins";
import { providerDriveName } from "../../shared/providers";
import type { SmzdmResourceLink } from "../../shared/smzdm";
import { wechatCoverFilePattern } from "../../shared/wechat-markup";
import { id } from "../database";
import { AppError } from "../errors";
import { shareUrlWithCode } from "../links";
import type { Repository } from "../repository";
import {
  availableKeyboardSkins,
  requireKeyboardSkinCandidates,
  type KeyboardSkinCandidate,
} from "../keyboard-skins";
import type { SecretStore } from "../secrets";
import { readWechatLocalImage } from "./local-image";

interface Dependencies {
  repo: Repository;
  secrets: SecretStore;
  dataPath: string;
}

async function availableCover(dataPath: string, coverId: string | null) {
  const file = `cover/${coverId ?? ""}`;
  if (!wechatCoverFilePattern.test(file)) return "";
  try {
    await readWechatLocalImage(dataPath, file);
    return `panxu-media://wechat/${file}`;
  } catch (error) {
    if (
      error instanceof AppError &&
      ["COVER_MISSING", "COVER_CHANGED"].includes(error.code)
    )
      return "";
    throw error;
  }
}

export function keyboardSkinDraftTitle(count: number) {
  return `手机键盘皮肤分享｜${count} 款`;
}

async function previewItem(
  dataPath: string,
  candidate: KeyboardSkinCandidate,
): Promise<KeyboardSkinItem> {
  return {
    id: candidate.id,
    title: candidate.title,
    provider: candidate.share.provider,
    coverUrl: await availableCover(dataPath, candidate.coverId),
  };
}

export async function sampleKeyboardSkins(
  d: Dependencies,
  count: number,
): Promise<KeyboardSkinSample> {
  const candidates = [...availableKeyboardSkins(d.repo).values()];
  if (candidates.length < count)
    throw new AppError(
      "KEYBOARD_SKINS_INSUFFICIENT",
      `当前有 ${candidates.length} 条可用键盘皮肤，请减少抽取数量或补充已核验分享。`,
    );
  for (let i = 0; i < count; i++) {
    const index = randomInt(i, candidates.length);
    [candidates[i], candidates[index]] = [candidates[index], candidates[i]];
  }
  return {
    title: keyboardSkinDraftTitle(count),
    items: await Promise.all(
      candidates.slice(0, count).map((item) => previewItem(d.dataPath, item)),
    ),
  };
}

function displayTitle(title: string) {
  return (
    title
      .replace(/https?:\/\/[^\s<>"'，。；）)\]]+/gi, "")
      .replace(/(?:提取码|访问码|密码)\s*[:：]?\s*[a-zA-Z0-9]{4,8}\b/g, "")
      .replace(/\[/g, "［")
      .replace(/\]/g, "］")
      .replace(/\*/g, "＊")
      .replace(/`/g, "｀")
      .replace(/[\s\0]+/g, " ")
      .trim() || "键盘皮肤"
  );
}

export async function resolveKeyboardSkinDraft(d: Dependencies, ids: string[]) {
  const candidates = requireKeyboardSkinCandidates(d.repo, ids);
  const items = await Promise.all(
    candidates.map(async (candidate) => {
      const { copyId, share } = candidate;
      const code = (await d.secrets.get(`share:${copyId}`)) ?? share.code;
      if (code && !/^[a-zA-Z0-9]{4,8}$/.test(code))
        throw new AppError(
          "KEYBOARD_SKINS_SHARE",
          "所选资源的分享提取码无效，请在资源库检查本人分享后重试。",
        );
      const preview = await previewItem(d.dataPath, candidate);
      const shareUrl = shareUrlWithCode(share.url, code);
      const codeText = code ? ` 提取码：${code}` : "";
      const link: SmzdmResourceLink = {
        id: id("smzlink"),
        url: share.url,
        sourceText: shareUrl + codeText,
        code,
        provider: share.provider,
        copyId,
        resourceId: candidate.id,
        ownUrl: share.url,
      };
      const shareLine = `[${providerDriveName(share.provider)}](${shareUrl})${codeText}`;
      return { ...preview, link, shareLine };
    }),
  );
  return {
    assertCurrent() {
      if (
        JSON.stringify(candidates) !==
        JSON.stringify(requireKeyboardSkinCandidates(d.repo, ids))
      )
        throw new AppError(
          "KEYBOARD_SKINS_CHANGED",
          "所选资源或分享状态已变化，请重新抽取。",
        );
    },
    digest: `本期整理 ${items.length} 款手机键盘皮肤，附网盘获取方式。`,
    coverUrl: items.find((item) => item.coverUrl)?.coverUrl ?? "",
    imageCount: items.filter((item) => item.coverUrl).length,
    links: items.map(({ link }) => link),
    body: [
      `本期整理了 ${items.length} 款手机键盘皮肤。网盘链接在各款名称下方，下载文件后请按所用输入法的方式导入。`,
      ...items.flatMap((item, index) => {
        const title = displayTitle(item.title);
        return [
          ...(item.coverUrl ? [`![${title}](${item.coverUrl})`] : []),
          `## ${String(index + 1).padStart(2, "0")} · ${title}`,
          item.shareLine,
        ];
      }),
      "你更喜欢哪一款？欢迎留言分享。",
    ].join("\n\n"),
  };
}
