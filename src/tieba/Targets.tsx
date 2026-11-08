import { z } from "zod";
import type {
  TiebaAutocareSnapshot,
  TiebaAutocareTarget,
} from "../../shared/tieba-autocare";
import { updateSelection } from "../lib/selection";
import { useLocalDraft } from "../hooks/useLocalDraft";
import {
  Button,
  Empty,
  Field,
  Panel,
  SearchField,
  Status,
  Notice,
} from "../ui/primitives";
import { CheckboxField } from "../ui/CheckboxField";
import { Pagination } from "../ui/Pagination";
import { Select } from "../ui/Select";
import {
  tiebaTargetCanSign,
  tiebaTargetRunLabel,
  tiebaAccountNeedsVerification,
  tiebaTargetRefreshIds,
  tiebaTime,
} from "./view-model";
import { AddForums } from "./AddForums";

export function TiebaTargets({
  snapshot: s,
  workspace,
  selected,
  busy,
  changed,
  stale,
  onSelection,
  onSync,
  onPause,
  onSave,
  onReset,
  onAccounts,
  onObserved,
  onReload,
  onFollow,
  onVerifyAccount,
  onRefreshProfiles,
}: {
  snapshot: TiebaAutocareSnapshot;
  workspace: string;
  selected: string[];
  busy: boolean;
  changed: boolean;
  stale: boolean;
  onSelection(ids: string[]): void;
  onSync(accountId: string): void;
  onPause(target: TiebaAutocareTarget): void;
  onSave(): void;
  onReset(): void;
  onAccounts(): void;
  onObserved(snapshot: TiebaAutocareSnapshot): void;
  onReload(): void;
  onFollow(target: TiebaAutocareTarget): void;
  onVerifyAccount(accountId: string): void;
  onRefreshProfiles(targetIds: string[]): void;
}) {
  const filters = useLocalDraft(
    `tieba-autocare-target-view:${workspace}`,
    { accountId: s.accounts[0]?.id ?? "", search: "", page: 1 },
    (value) =>
      z
        .object({
          accountId: z.string().max(150),
          search: z.string().max(200),
          page: z.number().int().min(1).max(100000),
        })
        .parse(value),
  );
  const { accountId, search, page } = filters.value;
  const account = s.accounts.find((item) => item.id === accountId);
  const accounts = new Map(s.accounts.map((item) => [item.id, item]));
  const filtered = s.targets.filter(
    (target) =>
      (!account || target.accountId === account.id) &&
      (!search ||
        target.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())),
  );
  const eligible = (target: TiebaAutocareTarget) => {
    const owner = accounts.get(target.accountId);
    return tiebaTargetCanSign(target, owner?.uid);
  };
  const refreshIds = tiebaTargetRefreshIds(filtered);
  const selectableIds = filtered.filter(eligible).map((item) => item.id);
  const selectedSet = new Set(selected);
  const allSelected =
    selectableIds.length > 0 &&
    selectableIds.every((id) => selectedSet.has(id));
  const currentPage = Math.min(
    page,
    Math.max(1, Math.ceil(filtered.length / 8)),
  );
  const visible = filtered.slice((currentPage - 1) * 8, currentPage * 8);
  return (
    <Panel
      className="tieba-targets"
      title="目标贴吧"
      extra={<small>已选 {selected.length} / 300 个 · 每吧每日签到一次</small>}
    >
      <div className="tieba-target-tools">
        <Field label="贴吧账号">
          <Select
            aria-label="选择贴吧账号"
            value={account?.id ?? ""}
            items={[
              {
                value: "",
                label: s.accounts.length ? "全部账号" : "尚未添加贴吧账号",
              },
              ...s.accounts.map((item) => ({
                value: item.id,
                label: `${item.alias || item.nickname || "贴吧账号"}${tiebaAccountNeedsVerification(item) ? " · 待核验" : ""}`,
              })),
            ]}
            disabled={busy || !s.accounts.length}
            onValueChange={(value) => {
              filters.update({ accountId: value, page: 1 });
            }}
          />
        </Field>
        <Button
          disabled={busy || !account}
          data-testid="tieba-verify-account"
          onClick={() => account && onVerifyAccount(account.id)}
        >
          核实账号
        </Button>
        <Button
          disabled={busy || !account}
          onClick={() => account && onSync(account.id)}
          data-testid="tieba-sync"
        >
          同步关注吧
        </Button>
        <AddForums
          snapshot={s}
          workspace={workspace}
          busy={busy}
          initialAccountId={account?.id ?? ""}
          receive={onObserved}
          reload={onReload}
        />
        <Button
          disabled={busy || !refreshIds.length}
          data-testid="tieba-refresh-profiles"
          title="读取当前筛选前5个贴吧的官网资料，不关注或签到"
          onClick={() => onRefreshProfiles(refreshIds)}
        >
          刷新资料
        </Button>
        <SearchField
          label="搜索目标贴吧"
          placeholder="搜索吧名"
          className="tieba-target-search"
          value={search}
          onChange={(value) => {
            filters.update({ search: value, page: 1 });
          }}
        />
        <Button quiet size="compact" onClick={onAccounts}>
          管理账号
        </Button>
      </div>
      <p className="tieba-target-refresh-scope">
        读取当前筛选前5个贴吧的官网资料，不关注或签到。本次范围：
        {refreshIds.length} / 5 个贴吧。
      </p>
      {filters.error ? <Notice warning>{filters.error}</Notice> : null}
      {account?.uid && tiebaAccountNeedsVerification(account) ? (
        <Notice warning>
          该账号保存了身份记录，但当前登录尚未核实。点击“核实账号”只读检查现有会话，成功后会恢复可用目标；不会弹出登录页或自动关注。
        </Notice>
      ) : null}
      {!s.accounts.length ? (
        <Empty
          compact
          title="先连接一个贴吧账号"
          action={
            <Button size="compact" onClick={onAccounts}>
              添加贴吧账号
            </Button>
          }
        >
          在账号管理完成官网登录和身份核验后，回到这里同步关注吧。
        </Empty>
      ) : !filtered.length ? (
        <Empty compact title={search ? "没有匹配的贴吧" : "尚未添加目标贴吧"}>
          {search
            ? "换一个吧名搜索，或切换上方账号。"
            : "添加贴吧时会自动关注；核实成功后可勾选签到，新增默认未选。"}
        </Empty>
      ) : (
        <>
          <div className="tieba-selection-tools">
            <CheckboxField
              label="选择筛选结果"
              checked={allSelected}
              disabled={busy || !selectableIds.length}
              onChange={(event) =>
                onSelection(
                  updateSelection(
                    selected,
                    selectableIds,
                    event.target.checked,
                    300,
                  ),
                )
              }
            />
            <span>添加时自动关注；核实成功后可勾选签到，新增默认未选。</span>
          </div>
          <div className="table-scroll">
            <table
              className="tieba-target-table"
              aria-label="目标贴吧与签到状态"
            >
              <thead>
                <tr>
                  <th scope="col">选择</th>
                  <th scope="col">贴吧 / 账号</th>
                  <th scope="col">等级</th>
                  <th scope="col">经验</th>
                  <th scope="col">签到 / 读取时间</th>
                  <th scope="col">运行状态</th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((target) => {
                  const owner = accounts.get(target.accountId);
                  const valid = !!owner?.uid && owner.uid === target.uid;
                  const observed = target.source === "observed";
                  const followUnknown = ["submitting", "uncertain"].includes(
                    target.followIntent?.status ?? "",
                  );
                  return (
                    <tr
                      key={target.id}
                      data-selected={selectedSet.has(target.id) || undefined}
                    >
                      <td>
                        <CheckboxField
                          label=""
                          aria-label={`自动签到 ${target.name}吧 · ${owner?.alias ?? "历史账号"}`}
                          checked={selectedSet.has(target.id)}
                          disabled={
                            busy ||
                            observed ||
                            ((!valid || selected.length >= 300) &&
                              !selectedSet.has(target.id))
                          }
                          title={
                            observed
                              ? "添加时会自动关注；官网核实成功后可选择签到，新增默认未选。"
                              : undefined
                          }
                          onChange={(event) =>
                            onSelection(
                              updateSelection(
                                selected,
                                [target.id],
                                event.target.checked,
                                300,
                              ),
                            )
                          }
                        />
                      </td>
                      <td>
                        <div className="tieba-target-name">
                          <strong>{target.name}吧</strong>
                          <span className="tieba-target-source">
                            {observed
                              ? followUnknown
                                ? "待核对"
                                : "待关注"
                              : "关注同步"}
                          </span>
                        </div>
                        <small>
                          {owner?.alias || owner?.nickname || "历史账号"}
                        </small>
                        {target.memberCount != null ||
                        target.postCount != null ||
                        target.threadCount != null ? (
                          <small>
                            {[
                              target.memberCount != null
                                ? `关注人数 ${target.memberCount.toLocaleString("zh-CN")}`
                                : "",
                              target.postCount != null
                                ? `帖子 ${target.postCount.toLocaleString("zh-CN")}`
                                : "",
                              target.threadCount != null
                                ? `主题 ${target.threadCount.toLocaleString("zh-CN")}`
                                : "",
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </small>
                        ) : null}
                      </td>
                      <td>
                        {target.level === null
                          ? "未取得"
                          : `Lv.${target.level}`}
                      </td>
                      <td>
                        {target.experience === null
                          ? "未取得"
                          : target.experience.toLocaleString("zh-CN")}
                      </td>
                      <td>
                        <span>
                          {target.signed === true
                            ? "今日已签到"
                            : target.signed === false
                              ? "今日未签到"
                              : "签到未核实"}
                        </span>
                        <small>{tiebaTime(target.checkedAt)}</small>
                      </td>
                      <td>
                        <Status
                          kind={!valid || target.paused ? "warning" : "normal"}
                        >
                          {tiebaTargetRunLabel(
                            target,
                            valid,
                            selectedSet.has(target.id),
                          )}
                        </Status>
                        {observed && !followUnknown ? (
                          <small>添加时自动关注，核实后可勾选签到</small>
                        ) : null}
                        {target.pauseReason ||
                        target.followIntent?.message ||
                        target.personalStatsMessage ||
                        target.message ? (
                          <small className="tieba-target-reason">
                            {target.pauseReason ||
                              target.followIntent?.message ||
                              target.personalStatsMessage ||
                              target.message}
                          </small>
                        ) : null}
                      </td>
                      <td>
                        <div className="tieba-target-actions">
                          {observed &&
                          target.followIntent?.status !== "verified" ? (
                            <Button
                              size="compact"
                              disabled={busy || !valid}
                              data-testid="tieba-follow"
                              title="官网确认关注后可选择签到；不会自动勾选或开启签到。"
                              onClick={() => onFollow(target)}
                            >
                              {followUnknown ? "核对关注" : "关注并加入"}
                            </Button>
                          ) : null}
                          <Button
                            size="compact"
                            quiet
                            disabled={busy || !valid || changed || stale}
                            title={changed ? "请先保存目标设置" : undefined}
                            onClick={() => onPause(target)}
                          >
                            {target.paused ? "恢复该吧" : "暂停该吧"}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pagination
            page={currentPage}
            pageSize={8}
            total={filtered.length}
            onPageChange={(value) => filters.update({ page: value })}
            label="目标贴吧分页"
          />
        </>
      )}
      <div className="tieba-target-footer">
        <span className="muted">
          {changed ? "目标选择尚未保存" : "已保存的目标会在开启后安排签到"}
        </span>
        <div className="row compact">
          <Button
            size="compact"
            disabled={busy || (!changed && !stale)}
            onClick={onReset}
          >
            恢复已保存设置
          </Button>
          <Button
            primary
            size="compact"
            disabled={busy || !changed || stale}
            onClick={onSave}
            data-testid="tieba-save"
          >
            {s.enabled ? "保存并应用" : "保存目标"}
          </Button>
        </div>
      </div>
    </Panel>
  );
}
