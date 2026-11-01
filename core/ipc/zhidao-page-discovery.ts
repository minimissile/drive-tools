import { z } from "zod";
import { pageDiscoveryInput } from "../../shared/zhidao-page-discovery";
import { exportDiscoveredPages } from "../zhidao/page-discovery/export";
import type { HandlerMap, HandlerServices } from "./types";

export function createZhidaoPageDiscoveryHandlers(
  s: Pick<HandlerServices, "zhidaoPages" | "ports">,
): HandlerMap {
  const idInput = z.object({ id: z.string().min(1).max(100) });
  return {
    "zhidaoPages.latest": () => s.zhidaoPages.latest(),
    "zhidaoPages.start": (input) =>
      s.zhidaoPages.start(pageDiscoveryInput.parse(input)),
    "zhidaoPages.pause": (input) =>
      s.zhidaoPages.pause(idInput.parse(input).id),
    "zhidaoPages.resume": (input) =>
      s.zhidaoPages.resume(idInput.parse(input).id),
    "zhidaoPages.browser": () => s.zhidaoPages.openBrowser(),
    "zhidaoPages.export": (input) => {
      const v = idInput
        .extend({ format: z.enum(["json", "csv"]) })
        .parse(input);
      const run = s.zhidaoPages.exportRun(v.id);
      return s.ports.saveFile(
        `百度知道网盘回答页-${run.createdAt.slice(0, 10)}.${v.format}`,
        exportDiscoveredPages(run, v.format),
      );
    },
  };
}
