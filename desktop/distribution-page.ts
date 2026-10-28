import type {
  DistributionReadiness,
  DistributionSubmitResult,
} from "../shared/distribution";

/** Only the public submission form is inspected. No credential or framework-state reads. */
function readForm() {
  const visible = (element: Element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const text = document.body?.innerText ?? "";
  if (
    /\/login(?:[/?#]|$)/.test(location.pathname) ||
    /请先登录后提交|登录后才能提交资源|当前网站要求登录/.test(text)
  )
    return {
      status: "login_required",
      message: "请先在该平台的独立窗口登录，再点击准备全库链接。",
    };
  if (
    Array.from(
      document.querySelectorAll(
        'iframe[src*="captcha"],iframe[src*="challenge"],[role="dialog"]',
      ),
    ).some(
      (element) =>
        visible(element) &&
        /验证码|人机验证|安全验证|captcha/i.test(
          element.textContent ?? element.getAttribute("src") ?? "",
        ),
    )
  )
    return {
      status: "verification_required",
      message: "平台要求人工验证，请在官网窗口完成后再继续。",
    };
  const inputs = Array.from(document.querySelectorAll("textarea")).filter(
    (element) => visible(element) && !element.disabled,
  );
  const input =
    inputs.find((element) => /网盘|分享链接/.test(element.placeholder)) ??
    inputs[0];
  const form = input?.closest("form");
  const button = form
    ? Array.from(
        form.querySelectorAll<HTMLButtonElement>('button[type="submit"]'),
      ).find((element) => /提交资源/.test(element.textContent ?? ""))
    : undefined;
  return input && button
    ? {
        status: "ready",
        message: "已检测到平台投稿表单，可以自动分发全部待处理的本人分享。",
      }
    : {
        status: "unavailable",
        message: "尚未检测到兼容的投稿表单；如网站结构变化，请先更新适配。",
      };
}
function fillForm(text: string) {
  const inputs = Array.from(document.querySelectorAll("textarea")).filter(
    (element) => {
      const r = element.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && !element.disabled;
    },
  );
  const input =
    inputs.find((element) => /网盘|分享链接/.test(element.placeholder)) ??
    inputs[0];
  if (!input) throw new Error("投稿输入框不存在。");
  if (input.maxLength > 0 && text.length > input.maxLength)
    throw new Error("本批内容超出官网输入长度限制。");
  Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )!.set!.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}
function clickSubmit(text: string) {
  const input = Array.from(document.querySelectorAll("textarea")).find(
    (element) =>
      element.value === text && element.getBoundingClientRect().width > 0,
  );
  const button = input
    ?.closest("form")
    ?.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (
    !input ||
    !button ||
    button.disabled ||
    !/提交资源/.test(button.textContent ?? "")
  )
    throw new Error("投稿内容或按钮状态已变化，未点击提交。");
  button.click();
}
export const distributionFormScript = () => `(${readForm.toString()})()`;
export const distributionFillScript = (text: string) =>
  `(${fillForm.toString()})(${JSON.stringify(text)})`;
export const distributionClickScript = (text: string) =>
  `(${clickSubmit.toString()})(${JSON.stringify(text)})`;
export type DistributionFormState = Pick<
  DistributionReadiness,
  "status" | "message"
>;

/** A 2xx HTTP response alone is not acceptance. Unknown envelopes remain uncertain. */
export function distributionReceipt(
  httpStatus: number,
  body: string,
): DistributionSubmitResult {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return {
      status: "uncertain",
      message: "平台未返回可识别的提交回执，请先核对官网，禁止自动重投。",
      receipt: "",
    };
  }
  if (!value || typeof value !== "object")
    return {
      status: "uncertain",
      message: "平台回执结构无法识别，请先核对结果。",
      receipt: "",
    };
  const data = value as { code?: unknown; msg?: unknown; data?: unknown };
  const message = typeof data.msg === "string" ? data.msg.slice(0, 500) : "";
  if (httpStatus >= 200 && httpStatus < 300 && data.code === 200) {
    const payload = data.data;
    const receipt =
      payload && typeof payload === "object"
        ? String(
            (payload as Record<string, unknown>).task_id ??
              (payload as Record<string, unknown>).taskId ??
              (payload as Record<string, unknown>).id ??
              "",
          ).slice(0, 500)
        : "";
    return {
      status: "accepted",
      message:
        typeof payload === "string"
          ? payload.slice(0, 500)
          : message || "平台已接受本批提交，等待后台处理；不代表已收录。",
      receipt,
    };
  }
  if (typeof data.code === "number" && data.code !== 200)
    return {
      status:
        [401, 403].includes(data.code) && /登录|身份/.test(message)
          ? "login_required"
          : /验证码|人机验证|安全验证/.test(message)
            ? "verification_required"
            : "rejected",
      message: message || `平台拒绝提交（${data.code}），已暂停。`,
      receipt: "",
    };
  return {
    status: "uncertain",
    message: "平台回执字段未适配，已暂停本批，请核对官网结果。",
    receipt: "",
  };
}
