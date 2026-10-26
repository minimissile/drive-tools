import { z } from "zod";

export const answerStyleNames = [
  "清晰实用",
  "步骤详解",
  "简洁回答",
  "共情陪伴",
  "第一人称共鸣",
  "温柔建议",
] as const;
export const answerStyle = z.enum(answerStyleNames);
export type AnswerStyle = z.infer<typeof answerStyle>;
export const answerStyleDetails: Record<
  AnswerStyle,
  { description: string; sample: string }
> = {
  清晰实用: {
    description: "直接回应问题，给出具体、可执行的建议。",
    sample: "可以先把困扰分成两部分：你能决定的事，以及需要和对方沟通的事。",
  },
  步骤详解: {
    description: "分步骤说明做法、依据与适用条件。",
    sample:
      "先梳理自己的感受，再找一个平静的时机沟通，最后一起确认下一步能做什么。",
  },
  简洁回答: {
    description: "用短段落说清重点，减少铺垫。",
    sample:
      "先照顾自己的感受，再表达具体需要。关系里的问题，不必由你一个人承担。",
  },
  共情陪伴: {
    description: "先接住情绪，再陪对方理清感受，不急着评判。",
    sample: "听起来，你难受的不只是这件事，更是自己的在意好像没有被认真对待。",
  },
  第一人称共鸣: {
    description: "以“我的理解”“我会建议”表达共鸣，像平等交谈。",
    sample:
      "我的理解是，你可能更在意自己的感受有没有被看见。我会建议，先别急着责怪自己，试着说清楚你期待怎样的回应。",
  },
  温柔建议: {
    description: "温和而有边界，给出能迈出的一小步。",
    sample:
      "如果现在还说不清，也可以先给自己一点时间。等情绪缓下来，再试着说出最希望对方理解的一件事。",
  },
};
