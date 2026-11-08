import { errors, type Page } from "playwright-core";
import { AppError } from "../errors";

export type TiebaAiDeclarationResult = "not_required" | "absent" | "selected";
const aiLabel = "贴子含AI内容";
const originalLabel = "贴子原创声明";
const itemSelector = "#ai-entrance-select-box .select-box-item";
const stateScript = String.raw`(() => {
  const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const text = el => (el.innerText || el.textContent || '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
  const roots = [...document.querySelectorAll('.ai-entrance')].filter(visible);
  const fallback = roots.length ? [] : [...document.querySelectorAll('.ai-entrance-text')].filter(visible);
  const entries = roots.length ? roots : fallback;
  const labels = entries.map(el => { const children = [...el.querySelectorAll('.ai-entrance-text')].filter(visible); return children.length > 1 ? null : text(children[0] || el); });
  const semantic = el => {
    const attrs = [el.getAttribute('aria-selected'), el.getAttribute('aria-checked')];
    if (attrs.includes('true') || el.querySelector('input[type="radio"]:checked,input[type="checkbox"]:checked')) return true;
    return attrs.includes('false') ? false : null;
  };
  const boxes = [...document.querySelectorAll('#ai-entrance-select-box')].filter(visible);
  const items = [...document.querySelectorAll('#ai-entrance-select-box .select-box-item')].filter(visible).map(el => ({text:text(el), selected:semantic(el), disabled:el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled')}));
  return {count:entries.length, selector:roots.length ? '.ai-entrance' : '.ai-entrance-text', labels,
    disabled:entries.some(el => el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled')),
    boxes:boxes.length, items};
})()`;
interface State {
  count: number;
  selector: string;
  labels: (string | null)[];
  disabled: boolean;
  boxes: number;
  items: { text: string; selected: boolean | null; disabled: boolean }[];
}
async function state(page: Page) {
  const url = new URL(page.url());
  if (url.origin !== "https://tieba.baidu.com" || url.username || url.password)
    throw new AppError(
      "TIEBA_AI_DECLARATION_ORIGIN",
      "内容声明必须在贴吧官方页面核实。",
    );
  const value = await page.evaluate<State>(stateScript);
  if (
    value.count > 1 ||
    value.boxes > 1 ||
    value.labels.some((label) => label === null) ||
    value.items.filter((item) => item.text === aiLabel).length > 1 ||
    (!value.count && value.boxes)
  )
    throw new AppError(
      "TIEBA_AI_DECLARATION_AMBIGUOUS",
      "官网内容声明入口或AI声明选项不唯一，已停止提交。",
    );
  return value;
}
function selected(value: State) {
  const ai = value.items.find((item) => item.text === aiLabel);
  const original = value.items.find((item) => item.text === originalLabel);
  if (
    original?.selected === true ||
    (value.labels[0] === aiLabel && ai?.selected === false)
  )
    return false;
  return value.labels[0] === aiLabel || ai?.selected === true;
}

/** A read-only final check; the expected result prevents a selected control disappearing unnoticed. */
export async function assertTiebaAiContentDeclaration(
  page: Page,
  aiGenerated: boolean,
  expected?: TiebaAiDeclarationResult,
): Promise<TiebaAiDeclarationResult> {
  if (!aiGenerated) return "not_required";
  const value = await state(page);
  if (!value.count && expected !== "selected") return "absent";
  if (!value.count || !selected(value))
    throw new AppError(
      "TIEBA_AI_DECLARATION_UNCONFIRMED",
      "未能核实官网已选中“贴子含AI内容”，已停止提交。",
    );
  return "selected";
}

/** Selects only the observed official AI-content option, never an originality claim. */
export async function ensureTiebaAiContentDeclaration(
  page: Page,
  aiGenerated: boolean,
): Promise<TiebaAiDeclarationResult> {
  if (!aiGenerated) return "not_required";
  let current = await state(page);
  if (!current.count) return "absent";
  if (selected(current)) return "selected";
  if (
    current.disabled ||
    !["内容声明", aiLabel, originalLabel].includes(current.labels[0] ?? "")
  )
    throw new AppError(
      "TIEBA_AI_DECLARATION_UNAVAILABLE",
      "官网内容声明状态无法识别，已停止提交。",
    );
  if (!current.boxes) {
    await page
      .locator(current.selector)
      .filter({ visible: true })
      .click({ timeout: 3000 });
    try {
      await page.waitForFunction(
        `(() => { const s = ${stateScript}; return s.boxes > 0; })()`,
        undefined,
        { timeout: 2000 },
      );
    } catch (error) {
      if (!(error instanceof errors.TimeoutError)) throw error;
      throw new AppError(
        "TIEBA_AI_DECLARATION_UNAVAILABLE",
        "官网未展开可核实的内容声明选项，已停止提交。",
      );
    }
  }
  current = await state(page);
  const choices = current.items.filter((item) => item.text === aiLabel);
  if (
    current.count !== 1 ||
    current.boxes !== 1 ||
    choices.length !== 1 ||
    choices[0].disabled
  )
    throw new AppError(
      "TIEBA_AI_DECLARATION_UNAVAILABLE",
      "官网没有唯一可用的“贴子含AI内容”选项，已停止提交。",
    );
  const option = page
    .locator(itemSelector)
    .filter({ visible: true })
    .filter({ hasText: /^\s*贴子含AI内容\s*$/u });
  if ((await option.count()) !== 1)
    throw new AppError(
      "TIEBA_AI_DECLARATION_AMBIGUOUS",
      "官网AI内容声明选项不唯一，已停止提交。",
    );
  await option.click({ timeout: 3000 });
  try {
    await page.waitForFunction(
      `(() => { const s = ${stateScript}; return s.labels[0] === '贴子含AI内容' || s.items.some(i => i.text === '贴子含AI内容' && i.selected === true); })()`,
      undefined,
      { timeout: 2000 },
    );
  } catch (error) {
    if (!(error instanceof errors.TimeoutError)) throw error;
    throw new AppError(
      "TIEBA_AI_DECLARATION_UNCONFIRMED",
      "选择后未能核实AI内容声明状态，已停止提交。",
    );
  }
  return assertTiebaAiContentDeclaration(page, aiGenerated, "selected");
}
