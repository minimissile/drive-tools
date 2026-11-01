import type { DistributionSubmitResult } from "../shared/distribution";

/** No CAPTCHA recognition or token extraction; the user types directly into the official form. */
function pikasooPage(
  action: "open" | "inspect" | "fill" | "check" | "submit" | "reset",
  text: string,
  previous: string,
) {
  if (
    location.protocol !== "https:" ||
    !["www.pikasoo.top", "pikasoo.top"].includes(location.hostname)
  )
    throw new Error("当前页面不属于皮卡搜索官网。");
  const visible = (element: Element) => {
    const rect = element.getBoundingClientRect();
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      getComputedStyle(element).visibility !== "hidden"
    );
  };
  let input = document.querySelector<HTMLTextAreaElement>(
    "#share-feedback-content",
  );
  if (action === "reset") {
    if (
      input?.readOnly &&
      input.value === previous &&
      document.getElementById("panxu-pikasoo-instruction")
    )
      document.getElementById("close-window")?.click();
    return null;
  }
  if (action === "open" && (!input || !visible(input))) {
    const entry = [
      ...document.querySelectorAll<HTMLElement>(".share-feedback"),
    ].find(visible);
    if (!entry)
      return {
        status: "unavailable",
        message: "未找到皮卡搜索的分享投稿入口。",
      };
    entry.click();
    return null;
  }
  const captcha = document.querySelector<HTMLInputElement>(
      "#share-feedback-captcha",
    ),
    image = document.querySelector<HTMLImageElement>("#captcha-img"),
    button = document.querySelector<HTMLButtonElement>(
      "#submit-share-feedback",
    );
  if (
    !input ||
    !captcha ||
    !image ||
    !button ||
    !visible(input) ||
    !visible(captcha) ||
    !visible(button)
  ) {
    if (["fill", "check", "submit"].includes(action))
      throw new Error("皮卡搜索投稿表单已变化，请暂停后重新准备。");
    return {
      status: "unavailable",
      message: "皮卡搜索投稿表单尚未就绪，请打开官网查看。",
    };
  }
  if (action === "inspect")
    return input.value.trim()
      ? {
          status: "unavailable",
          message: "官网有未提交内容，请先处理或关闭官网窗口，避免覆盖。",
        }
      : {
          status: "ready",
          message: "皮卡搜索支持整批多行链接；运行后每批由你手动输入验证码。",
        };
  if (action === "fill") {
    const owned =
      input.readOnly &&
      input.value === previous &&
      document.getElementById("panxu-pikasoo-instruction");
    if (
      (input.value.trim() && !owned) ||
      button.textContent?.trim() !== "立即提交"
    )
      throw new Error("官网有其他内容或正在提交，未覆盖表单。");
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    // The site's focus handler hides its overlaid example text; input/change alone do not.
    input.focus();
    input.readOnly = true;
    captcha.value = "";
    captcha.readOnly = false;
    captcha.autocomplete = "off";
    button.disabled = true;
    let notice = document.getElementById("panxu-pikasoo-instruction");
    if (!notice) {
      notice = document.createElement("p");
      notice.id = "panxu-pikasoo-instruction";
      notice.style.margin = "12px 0";
      notice.style.fontWeight = "600";
      button.before(notice);
    }
    notice.textContent = `本批 ${text.split("\n").length} 条链接已由盘序填写。请在上方手动输入验证码，再回盘序点击“提交本批”；需要时可点击验证码图片刷新。`;
    captcha.focus();
    return null;
  }
  if (action === "check" || action === "submit") {
    if (
      input.value !== text ||
      !input.readOnly ||
      !document.getElementById("panxu-pikasoo-instruction")
    )
      throw new Error("本批链接或官网页面已变化，请暂停后重新准备。");
    if (!image.complete || image.naturalWidth === 0)
      throw new Error("验证码图片尚未加载，请在官网刷新图片后输入。");
    if (!captcha.value.trim())
      throw new Error("请先在官网窗口手动输入验证码。");
    if (button.textContent?.trim() !== "立即提交")
      throw new Error("官网仍在处理提交，请等待结果。");
    if (action === "submit") {
      captcha.readOnly = true;
      button.disabled = false;
      button.click();
      // The official jQuery callback updates its text; keep manual clicks disabled until a new checkpoint.
      button.disabled = true;
    }
    return true;
  }
  return null;
}
export const pikasooPageScript = (
  action: Parameters<typeof pikasooPage>[0],
  text = "",
  previous = "",
) =>
  `(${pikasooPage.toString()})(${JSON.stringify(action)},${JSON.stringify(text)},${JSON.stringify(previous)})`;

/** The site's official callback treats negative codes as rejection and -403 as a fresh CAPTCHA. */
export function pikasooReceipt(
  status: number,
  body: string,
): DistributionSubmitResult {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {}
  const code =
    value && typeof value === "object"
      ? (value as Record<string, unknown>).code
      : undefined;
  if (
    status >= 200 &&
    status < 300 &&
    typeof code === "number" &&
    Number.isSafeInteger(code)
  ) {
    if (code === -403)
      return {
        status: "verification_required",
        notAccepted: true,
        message: "验证码未通过，官网未接受本批投稿；请重新手动输入新验证码。",
        receipt: "",
      };
    if (code < 0)
      return {
        status: "rejected",
        message: `皮卡搜索拒绝本批投稿（${code}），请打开官网查看原因。`,
        receipt: "",
      };
    return {
      status: "accepted",
      message:
        "皮卡搜索已接受本批投稿，等待平台处理收录；不代表每条链接已收录。",
      receipt: "",
    };
  }
  return {
    status: "uncertain",
    message: "未取得皮卡搜索可识别的整批回执，请核对官网结果，禁止自动重投。",
    receipt: "",
  };
}
