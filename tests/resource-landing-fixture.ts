import type {
  LandingDraft,
  LandingSource,
  PublishedLanding,
} from "../shared/resource-landing";
import { landingSearchPolicyVersion } from "../shared/resource-landing";
export const review = {
  policyVersion: landingSearchPolicyVersion,
  score: 92,
  dimensions: {
    evidence: 24,
    intent: 23,
    specificity: 18,
    readability: 13,
    trust: 14,
  },
  verdict: "pass" as const,
  reasons: [],
  unsupportedClaims: [],
};
/** Synthetic content with explicit page evidence, never presented as the real PDF. */
export function article(): LandingDraft {
  return {
    title: "人情世故指南 PDF：职场请求与边界表达",
    description:
      "这份测试资料按职场沟通情境组织，介绍提出请求和拒绝临时任务的表达方式，可根据具体页码查阅案例及其适用条件。",
    summary:
      "这份测试PDF围绕职场请求与边界表达展开。前一页比较两种提出请求的写法，后一页讨论临时任务的优先级确认。可以按自己遇到的情境查阅，案例并不意味着所有职场关系都适用。",
    highlights: ["按请求与边界两种情境查阅", "案例旁保留具体页码，便于核对"],
    sections: [
      {
        heading: "提出请求时交代什么",
        kind: "facts",
        evidenceIds: ["doc-1-p1"],
        body: "第1页的案例比较了只说结果与同时交代背景、时间和可选方案的两种请求写法。区别在于接收方能否判断自己要投入多少时间，案例用于说明请求所需的信息，并不代表对方一定会答应。",
      },
      {
        heading: "临时任务怎样确认优先级",
        kind: "facts",
        evidenceIds: ["doc-1-p2"],
        body: "第2页讨论临时增加任务时如何先确认原有工作的截止时间与优先级，再询问是否需要调整交付安排。它更适合同时处理多项工作的人查阅，而不是用一句拒绝话术代替实际协商。",
      },
    ],
    faq: [],
  };
}
export function source(): LandingSource {
  return {
    resourceTitle: "人情世故指南（PDF）",
    category: "学习资料",
    tags: [],
    facts: [
      {
        id: "doc-1-p1",
        label: "第1页",
        text: "请求案例比较了背景、时间和可选方案。",
      },
      {
        id: "doc-1-p2",
        label: "第2页",
        text: "临时任务需确认截止时间、优先级和交付安排。",
      },
      { id: "title", label: "资料名称", text: "人情世故指南（PDF）" },
      {
        id: "file-1",
        label: "文件记录",
        text: "人情世故指南.pdf；大小 4800000 字节",
      },
    ],
    files: [
      {
        evidenceId: "file-1",
        name: "人情世故指南.pdf",
        size: 4800000,
        directory: false,
      },
    ],
    documents: [
      {
        fileEvidenceId: "file-1",
        name: "人情世故指南.pdf",
        sha256: "b".repeat(64),
        pageCount: 2,
        pages: [1, 2],
        sampled: false,
        readAt: "2026-11-02T00:00:00.000Z",
      },
    ],
    manifestTruncated: false,
    shareCheckedAt: "2026-11-02T00:00:00.000Z",
    fingerprint: "a".repeat(64),
  };
}
export function document(): PublishedLanding {
  return {
    schemaVersion: 1,
    article: article(),
    source: source(),
    review,
    generatedAt: "2026-11-02T00:00:00.000Z",
  };
}
