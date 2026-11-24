import {
  createElement,
  Fragment,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { PublishingQuestion } from "../../shared/zhidao-workflow";
import { Loading } from "../ui/DataState";
import { Dialog } from "../ui/Dialog";
import { Pagination } from "../ui/Pagination";
import { Button } from "../ui/primitives";
import { wechatImagePreviewUrl } from "../wechat/image-preview";

export interface PublishingPreviewGroup {
  id: string;
  title: string;
  pendingLinks?: boolean;
  rows: Pick<PublishingQuestion, "question" | "answer">[];
}

const pageSize = 5;
const formattingTags = new Set([
  "b",
  "blockquote",
  "caption",
  "code",
  "del",
  "div",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "i",
  "li",
  "ol",
  "p",
  "pre",
  "s",
  "span",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
]);
const omittedTags = new Set([
  "audio",
  "embed",
  "form",
  "iframe",
  "noscript",
  "object",
  "script",
  "style",
  "template",
  "video",
]);

function hasPreviewContent(node: ReactNode) {
  return typeof node === "string" ? !!node.trim() : node != null;
}

function baiduShareHref(raw: string) {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" &&
      ["pan.baidu.com", "yun.baidu.com"].includes(url.hostname) &&
      /^\/s\/[a-z\d_-]+\/?$/i.test(url.pathname) &&
      !url.username &&
      !url.password &&
      !url.port
      ? url.href
      : "";
  } catch {
    return "";
  }
}

function PreviewImage({
  source,
  description,
}: {
  source: string;
  description: string;
}) {
  const [phase, setPhase] = useState<"idle" | "loading" | "loaded" | "error">(
    "idle",
  );
  const expanded = phase === "loading" || phase === "loaded";
  return (
    <span className="publishing-preview-image">
      <span className="publishing-preview-image-tools">
        <Button
          quiet
          size="compact"
          aria-expanded={expanded}
          onClick={() => setPhase(expanded ? "idle" : "loading")}
        >
          {expanded
            ? "收起图片"
            : phase === "error"
              ? "重试显示图片"
              : "显示图片"}
        </Button>
        {phase === "loading" ? <Loading label="正在加载图片…" /> : null}
        {phase === "error" ? (
          <span role="status">图片暂时无法加载。</span>
        ) : null}
      </span>
      {expanded ? (
        <img
          src={source}
          alt={description || "回答配图"}
          hidden={phase === "loading"}
          onLoad={() => setPhase("loaded")}
          onError={() => setPhase("error")}
        />
      ) : null}
    </span>
  );
}

function previewNode(node: Node, index: number): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (!(node instanceof HTMLElement)) return null;
  const tag = node.localName;
  if (omittedTags.has(tag)) return null;
  if (tag === "br" || tag === "hr") return createElement(tag, { key: index });
  if (tag === "img") {
    const description = node.getAttribute("alt")?.trim() ?? "";
    const address = node.getAttribute("src")?.trim() ?? "";
    const source =
      /^https:\/\//i.test(address) && address.length <= 8000
        ? wechatImagePreviewUrl(address)
        : "";
    if (source)
      return (
        <PreviewImage key={index} source={source} description={description} />
      );
    return (
      <span key={index} className="publishing-preview-image">
        {description ? `图片（${description}）` : "图片"}
      </span>
    );
  }
  const children = Array.from(node.childNodes, previewNode);
  if (!children.some(hasPreviewContent)) return null;
  const link =
    tag === "a" ? baiduShareHref(node.getAttribute("href") ?? "") : "";
  if (link)
    return (
      <span key={index} className="publishing-preview-share" title={link}>
        {children}
      </span>
    );
  return formattingTags.has(tag) ? (
    createElement(tag, { key: index }, children)
  ) : (
    <Fragment key={index}>{children}</Fragment>
  );
}

function PreviewAnswer({ answer }: { answer: string }) {
  if (!answer.trim()) return <p className="muted">尚未填写回答。</p>;
  // Rebuild formatting from inert markup. Remote images use the protected
  // preview transport only after the user expands them.
  const source = document.createElement("template");
  source.innerHTML = answer;
  const nodes = Array.from(source.content.childNodes, previewNode);
  if (!nodes.some(hasPreviewContent))
    return <p className="muted">暂无可预览的回答。</p>;
  return (
    <div
      className="publishing-preview-answer"
      data-plain={source.content.children.length === 0 || undefined}
    >
      {nodes}
    </div>
  );
}

export function PublishingPreview({
  groups,
  onClose,
}: {
  groups: PublishingPreviewGroup[];
  onClose(): void;
}) {
  const [requestedPage, setPage] = useState(1);
  const list = useRef<HTMLDivElement>(null);
  const resourceCount = groups.filter((group) => group.rows.length).length;
  const total = groups.reduce((count, group) => count + group.rows.length, 0);
  const page = Math.min(
    requestedPage,
    Math.max(1, Math.ceil(total / pageSize)),
  );
  const start = (page - 1) * pageSize;
  const end = start + pageSize;
  let groupStart = 0;
  const visibleGroups = groups.flatMap((group) => {
    const first = Math.max(0, start - groupStart);
    const last = Math.max(0, end - groupStart);
    groupStart += group.rows.length;
    const rows = group.rows.slice(first, last);
    return rows.length ? [{ ...group, first, rows }] : [];
  });

  return (
    <Dialog
      title="问答预览"
      className="publishing-preview-dialog"
      focus="container"
      onClose={onClose}
      footer={
        <Pagination
          label="问答预览分页"
          numbered
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={(next) => {
            setPage(next);
            list.current?.scrollTo(0, 0);
          }}
        />
      }
    >
      <p className="publishing-preview-summary">
        {resourceCount} 份资源 · {total} 条问答
        {groups.some((group) => group.pendingLinks)
          ? " · 介绍确认后再准备独立链接"
          : " · 每条问答一个独立链接"}
      </p>
      <div
        ref={list}
        className="publishing-preview-list"
        role="region"
        aria-label="问答预览内容"
        tabIndex={0}
      >
        {visibleGroups.map((group) => (
          <section key={group.id} aria-label={group.title}>
            <h3>{group.title}</h3>
            {group.rows.map((row, index) => (
              <article
                key={group.first + index}
                className="publishing-preview-item"
              >
                <h4>{row.question.trim() || "尚未填写问题标题"}</h4>
                <PreviewAnswer answer={row.answer} />
              </article>
            ))}
          </section>
        ))}
        {total === 0 ? <p className="muted">暂无可预览的问答。</p> : null}
      </div>
    </Dialog>
  );
}
