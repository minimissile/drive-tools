import type { BitBrowser } from "./bitbrowser";
import type { BrowserEnvironments } from "./browser-environments";
import type {
  BrowserEnvironmentView,
  EnvironmentAccountRef,
} from "../shared/browser-environments";
import type {
  BitBrowserAccountState,
  BitBrowserDiagnostic,
  BitBrowserWindows,
  BitProfileCommand,
} from "../shared/bitbrowser";
import { AppError, safeMessage } from "./errors";
import { now } from "./database";

/** Coordinates explicit controls without letting a window list mutate account state. */
export class BitBrowserManagement {
  private active = new Set<string>();
  constructor(
    private deps: {
      bit: BitBrowser;
      environments: BrowserEnvironments;
      connector(): string;
      accountState(ref: EnvironmentAccountRef): BitBrowserAccountState;
      pendingOperations(refs: EnvironmentAccountRef[]): string[];
      openAccount(ref: EnvironmentAccountRef): Promise<unknown>;
    },
  ) {}

  get isBusy() {
    return this.active.size > 0;
  }

  private assertConnector(key: string) {
    if (!key || key !== this.deps.connector())
      throw new AppError(
        "BIT_CONNECTION_CHANGED",
        "比特连接地址已变化，请重新读取窗口列表后操作。",
      );
  }

  private environment(profileId: string) {
    return this.deps.environments
      .list()
      .find(
        (env) => env.engine === "bitbrowser" && env.profileId === profileId,
      );
  }

  private assertEnvironmentConnector(env?: BrowserEnvironmentView) {
    if (env?.connectorKey && env.connectorKey !== this.deps.connector())
      throw new AppError(
        "ENVIRONMENT_CONNECTOR_CHANGED",
        "此环境登记于另一个比特服务，请恢复原连接后操作。",
      );
  }

  async list(): Promise<BitBrowserWindows> {
    const connectorKey = this.deps.connector();
    const profiles = await this.deps.bit.profiles();
    let running: Set<string> | null = null;
    let statusError = "";
    try {
      running = await this.deps.bit.runningProfiles(
        profiles.map((profile) => profile.id),
      );
    } catch (error) {
      statusError = `运行状态读取失败：${safeMessage(error)} 窗口列表已保留，请刷新重试。`;
    }
    this.assertConnector(connectorKey);
    return {
      connectorKey,
      checkedAt: now(),
      statusError,
      windows: profiles.map((profile) => ({
        ...profile,
        running: running ? running.has(profile.id) : null,
      })),
    };
  }

  async diagnose(input: BitProfileCommand): Promise<BitBrowserDiagnostic> {
    this.assertConnector(input.connectorKey);
    const env = this.environment(input.profileId);
    const blockers: string[] = [];
    try {
      this.assertEnvironmentConnector(env);
    } catch (error) {
      blockers.push(safeMessage(error));
    }
    if (env?.busy)
      blockers.push("环境有执行中或排队的任务，请回到原业务完成或取消。");
    if (this.active.has(input.profileId))
      blockers.push("窗口控制操作正在进行，请等待完成。");
    for (const ref of env?.accounts ?? []) {
      try {
        this.deps.environments.assertAccountIdle(ref);
      } catch (error) {
        const message = safeMessage(error);
        if (!blockers.includes(message)) blockers.push(message);
      }
    }
    let configuration: BitBrowserDiagnostic["configuration"] = null;
    let configurationError = "";
    try {
      configuration = await this.deps.bit.profileDetails(input.profileId);
    } catch (error) {
      configurationError = safeMessage(error);
    }
    this.assertConnector(input.connectorKey);
    return {
      checkedAt: now(),
      configuration,
      configurationError,
      blockers,
      accounts: (env?.accounts ?? []).map((ref) => this.deps.accountState(ref)),
      pendingOperations: this.deps.pendingOperations(env?.accounts ?? []),
    };
  }

  private async control<T>(input: BitProfileCommand, action: () => Promise<T>) {
    this.assertConnector(input.connectorKey);
    if (this.active.has(input.profileId))
      throw new AppError(
        "BIT_WINDOW_BUSY",
        "此窗口正在处理其他控制操作，请等待完成。",
      );
    this.assertEnvironmentConnector(this.environment(input.profileId));
    this.active.add(input.profileId);
    try {
      return await action();
    } finally {
      this.active.delete(input.profileId);
    }
  }

  open(input: BitProfileCommand) {
    return this.control(input, async () => {
      const env = this.environment(input.profileId);
      const drive = env?.accounts.find((a) => a.kind === "drive");
      if (drive) {
        await this.deps.openAccount(drive);
        return true;
      }
      const action = () =>
        this.deps.bit.withProfile(
          input.profileId,
          async (context) => {
            const page = context.pages().find((page) => !page.isClosed());
            if (page) await page.bringToFront();
            return true;
          },
          input.connectorKey,
        );
      return env
        ? this.deps.environments.runEnvironment(env.id, "window:open", action)
        : action();
    });
  }

  close(input: BitProfileCommand & { expectedRevision?: number }) {
    return this.control(input, async () => {
      const env = this.environment(input.profileId);
      const action = async () => {
        this.assertConnector(input.connectorKey);
        await this.deps.bit.closeProfile(input.profileId, input.connectorKey);
        return true;
      };
      return env
        ? this.deps.environments.controlWindow(
            env.id,
            action,
            input.expectedRevision,
          )
        : action();
    });
  }

  openAccount(input: BitProfileCommand & { account: EnvironmentAccountRef }) {
    return this.control(input, async () => {
      const env = this.deps.environments.forAccount(input.account);
      if (env.engine !== "bitbrowser" || env.profileId !== input.profileId)
        throw new AppError(
          "ENVIRONMENT_CHANGED",
          "账号关联的窗口已变化，请刷新列表后操作。",
        );
      this.assertEnvironmentConnector({ ...env, accounts: [], busy: false });
      await this.deps.openAccount(input.account);
      return true;
    });
  }
}
