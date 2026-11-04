import {
  zhihuParticipationDiscoverInput,
  zhihuParticipationInspectInput,
  zhihuParticipationPlanInput,
  zhihuParticipationSaveInput,
  zhihuParticipationResolveInput,
  zhihuParticipationAnswerInput,
} from "../../shared/zhihu-participation";
import type { HandlerServices } from "./types";
import { AppError } from "../errors";
import { runtimeLogQuery } from "../../shared/runtime-logs";
import { zhihuInteractionReconcileInput } from "../../shared/zhihu-interaction";

export function createZhihuParticipationHandlers({
  zhihuParticipation,
  intelligentOps,
}: Pick<HandlerServices, "zhihuParticipation" | "intelligentOps">) {
  const participation = zhihuParticipation;
  return {
    "zhihu.participation.logs": (raw: unknown) =>
      participation.logs.read(runtimeLogQuery.parse(raw)),
    "zhihu.participation.snapshot": () => participation.snapshot(),
    "zhihu.participation.discover": (raw: unknown) =>
      participation.discover(zhihuParticipationDiscoverInput.parse(raw)),
    "zhihu.participation.inspect": (raw: unknown) =>
      participation.inspect(zhihuParticipationInspectInput.parse(raw)),
    "zhihu.participation.plan": (raw: unknown) => {
      const input = zhihuParticipationPlanInput.parse(raw);
      if (
        input.planId &&
        !intelligentOps
          .snapshot()
          .plans.some(
            (plan) =>
              plan.id === input.planId &&
              plan.accounts.some(
                (a) => a.channel === "zhihu" && a.accountId === input.accountId,
              ),
          )
      )
        throw new AppError(
          "ZHIHU_PARTICIPATION_PLAN_SCOPE",
          "所选账号不属于此运营计划，请重新核对参与范围。",
        );
      return participation.plan(input);
    },
    "zhihu.participation.save": (raw: unknown) =>
      participation.save(zhihuParticipationSaveInput.parse(raw)),
    "zhihu.participation.resolve": (raw: unknown) =>
      participation.resolve(zhihuParticipationResolveInput.parse(raw)),
    "zhihu.participation.answer": (raw: unknown) =>
      participation.answer(zhihuParticipationAnswerInput.parse(raw)),
    "zhihu.participation.reconcile": (raw: unknown) =>
      participation.reconcileInteraction(
        zhihuInteractionReconcileInput.parse(raw),
      ),
  };
}
