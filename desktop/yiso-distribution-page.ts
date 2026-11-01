import type { DistributionSubmitResult } from "../shared/distribution";
import type { DistributionFormState } from "./distribution-page";

/** The official page owns submission and its request signatures; only DOM controls are used. */
function yisoPage(
  action: "inspect" | "dismiss" | "fill" | "submit" | "result",
  text: string,
) {
  const visible = (element: Element) => {
    const r = element.getBoundingClientRect();
    return (
      r.width > 0 &&
      r.height > 0 &&
      getComputedStyle(element).visibility !== "hidden"
    );
  };
  const body = document.body?.innerText ?? "";
  const dialogs = [
    ...document.querySelectorAll('[role="dialog"],.el-message-box'),
  ].filter(visible);
  const challenge =
    /正在进行安全验证|验证您不是自动程序|只允许每个用户打开一个提交页面/.test(
      body,
    ) ||
    [
      ...document.querySelectorAll(
        'iframe[src*="captcha"],iframe[src*="challenge"]',
      ),
    ].some(visible) ||
    dialogs.some((element) =>
      /验证码|人机验证|安全验证/.test(element.textContent ?? ""),
    );
  if (challenge)
    return {
      status: "verification_required",
      message:
        "易搜要求安全验证或仅允许一个投稿页，请打开投稿页处理后重新准备。",
    };
  if (action === "dismiss") {
    // Close only the known, non-binding domain announcement using its own Cancel button.
    for (const dialog of dialogs) {
      if (
        /重要通知/.test(dialog.textContent ?? "") &&
        /永久发布页/.test(dialog.textContent ?? "")
      )
        [...dialog.querySelectorAll<HTMLButtonElement>("button")]
          .find((button) => button.textContent?.trim() === "取消")
          ?.click();
    }
    return null;
  }
  const input = document.querySelector<HTMLTextAreaElement>("textarea#subId"),
    button = document.querySelector<HTMLButtonElement>("button#sub-button");
  if (
    location.protocol !== "https:" ||
    !["yiso.fun", "www.yiso.fun"].includes(location.hostname) ||
    location.pathname !== "/submit" ||
    !input ||
    !button ||
    !visible(input) ||
    !visible(button) ||
    button.textContent?.trim() !== "提交收录"
  )
    return {
      status: "unavailable",
      message: "尚未检测到兼容的易搜投稿表单，请查看官网页面后重试。",
    };
  const processing =
    input.disabled ||
    button.disabled ||
    button.classList.contains("btn-loading");
  if (action === "inspect")
    return dialogs.length || processing || input.value.trim()
      ? {
          status: "unavailable",
          message:
            "易搜页面有未处理的弹窗、链接或提交任务，请在投稿页处理完毕后重新准备。",
        }
      : {
          status: "ready",
          message: "易搜投稿表单已就绪，无需账号；将逐条等待官网处理结果。",
        };
  if (action === "fill") {
    if (dialogs.length || processing || input.value.trim())
      throw new Error("易搜表单并非空闲状态，未覆盖页面内容。");
    if (!text || text.includes("\n"))
      throw new Error("易搜仅允许逐条自动提交。");
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return null;
  }
  if (action === "submit") {
    if (dialogs.length || processing || input.value !== text)
      throw new Error("易搜投稿内容或按钮状态已变化，未点击提交。");
    button.click();
    return null;
  }
  if (processing) return null;
  // Initial toast says success before any request. Only the final per-link result card counts.
  for (const card of document.querySelectorAll(".card")) {
    const header = card.querySelector(".card-header");
    const successful = header?.classList.contains("bg-success");
    const failed = header?.classList.contains("bg-danger");
    if (!successful && !failed) continue;
    const entry = [
      ...card.querySelectorAll<HTMLElement>(".card-body > .mb-2"),
    ].find(
      (element) =>
        element.querySelector(".fw-bold")?.textContent?.trim() === text &&
        element.querySelector("small")?.textContent?.trim() === text,
    );
    if (!entry) continue;
    if (successful && !input.value.trim())
      return {
        status: "accepted",
        message:
          "易搜已返回此链接的提交成功结果，页面处理已结束；收录仍以平台为准。",
        receipt: "",
      };
    if (failed) {
      const message =
        entry
          .querySelector(".text-danger.small")
          ?.textContent?.trim()
          .slice(0, 500) ?? "";
      return {
        status:
          !message || /服务器异常|网络|超时|timeout/i.test(message)
            ? "uncertain"
            : "rejected",
        message:
          message || "易搜返回失败结果，但未提供可核实原因，请在官网核对。",
        receipt: "",
      };
    }
  }
  return null;
}
export const yisoPageScript = (
  action: Parameters<typeof yisoPage>[0],
  text = "",
) =>
  `(${yisoPage.toString()})(${JSON.stringify(action)},${JSON.stringify(text)})`;
export type YisoPageResult =
  DistributionSubmitResult | DistributionFormState | null;
