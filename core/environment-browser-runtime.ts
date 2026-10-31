import type { BrowserContext } from "playwright-core";
import type { EnvironmentAccountRef } from "../shared/browser-environments";
import type { BrowserEnvironments } from "./browser-environments";
import type { BitBrowser } from "./bitbrowser";
import { AppError } from "./errors";

/** Caller holds the environment lease; visible opens additionally require window-control guards. */
export function withEnvironmentBrowser<T>(
  environments: BrowserEnvironments,
  bit: BitBrowser,
  ref: EnvironmentAccountRef,
  action: (context: BrowserContext) => Promise<T>,
  visible = false,
): Promise<T> {
  const env = environments.forAccount(ref);
  if (env.engine !== "bitbrowser")
    throw new AppError(
      "ENVIRONMENT_ENGINE_MISMATCH",
      "此操作需要指纹浏览器环境。",
    );
  const sharesDrive = environments
    .list()
    .find((e) => e.id === env.id)
    ?.accounts.some((a) => a.kind === "drive");
  if (sharesDrive && !visible)
    return bit.withDriveProfile(env.profileId, false, action, env.connectorKey);
  if (sharesDrive && visible)
    return bit
      .stopDriveHeadless(env.profileId, env.connectorKey)
      .then(() => bit.withProfile(env.profileId, action, env.connectorKey));
  return bit.withProfile(env.profileId, action, env.connectorKey);
}
