import { wechatRewriteBody } from "./rewrite-body";

type Section = { id: number; text: string; locked?: boolean };

function prose(sections: Section[]) {
  return sections
    .filter((section) => !section.locked)
    .map(({ text }) =>
      text
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`/g, ""),
    );
}

/** Brief copy stays brief; longer multi-paragraph copy must have an actual outline. */
export function wechatRewriteLayout(sections: Section[]) {
  const texts = prose(sections);
  const length = texts.join("").replace(/[\s#*>_`-]/g, "").length;
  const paragraphs = texts
    .flatMap((text) => text.split(/\n+/))
    .filter((text) => !!text.trim()).length;
  return {
    minHeadings: length >= 100 && paragraphs >= 3 ? (length >= 600 ? 2 : 1) : 0,
    minEmphasis: length >= 100 ? 1 : 0,
  };
}

/** Promote an existing standalone lead-in, without adding words, moving sections, or changing assets. */
export function prepareWechatRewriteLayout(
  sections: Section[],
  minimum: ReturnType<typeof wechatRewriteLayout>,
) {
  const requirement = wechatRewriteLayout(sections);
  const minHeadings = Math.max(minimum.minHeadings, requirement.minHeadings);
  let headingCount =
    prose(sections)
      .join("\n")
      .match(/^#{2,3}\s+\S.+$/gm)?.length ?? 0;
  const prepared = sections.map((section) => ({
    ...section,
    text: section.text.replace(
      /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`|<br\s*\/?>/gi,
      (part) => (part.startsWith("<") ? "\n" : part),
    ),
  }));
  if (headingCount < minHeadings) {
    for (const section of prepared) {
      if (section.locked || /^(?:```|~~~)/m.test(section.text)) continue;
      section.text = section.text.replace(
        /^([^\s#>*\d][^\n。！？.!?：:]{1,22})[:：][ \t]*$/gm,
        (line, label: string) => {
          if (headingCount >= minHeadings) return line;
          headingCount++;
          return `## ${label}`;
        },
      );
    }
  }
  const text = prose(prepared).join("\n\n");
  const issues: string[] = [];
  if (headingCount < minHeadings)
    issues.push(
      `正文需要至少 ${minHeadings} 个有信息量的 ## 小标题，目前只有 ${headingCount} 个`,
    );
  if (
    Math.max(minimum.minEmphasis, requirement.minEmphasis) &&
    !/\*\*[^*\n]+\*\*/.test(text)
  )
    issues.push("正文需要用 **关键概念或条件** 强调至少一处已有重点");
  return { sections: prepared, issues };
}

/** Manual typesetting can repair existing lead-ins without an AI call or changing protected content. */
export function formatWechatRewriteBody(body: string) {
  const { sections, entries } = wechatRewriteBody(body);
  const formatted = prepareWechatRewriteLayout(
    sections,
    wechatRewriteLayout(sections),
  );
  const texts = new Map(
    formatted.sections
      .filter((section) => !section.locked)
      .map(({ id, text }) => [id, text]),
  );
  return entries
    .map(({ id, text }) => (id === null ? text : (texts.get(id) ?? text)))
    .join("");
}
