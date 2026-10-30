import { windowStorage } from "../storage/window-storage";
import { useEffect, useState } from "react";
import {
  collectionDriveLabels,
  collectionDriveTypes,
  collectionTransferProvider,
  type CollectionDriveFilter,
} from "../../shared/resource-collection";
import { providerSpecs } from "../../shared/providers";
import { useAppActions, useAppData, useAppNavigation } from "../state";
import { Button, Empty, Field, LoadingState } from "../ui/primitives";
import { Select } from "../ui/Select";
import { ResultTable } from "../zhidao/Results";
import { useOperationAction, type OperationModel } from "../zhidao/hooks";

export function CollectionResults({
  model,
  targetAccount,
  directory,
  onTargetChange,
  onDirectoryChange,
}: {
  model: OperationModel;
  targetAccount: string;
  directory: string;
  onTargetChange(value: string): void;
  onDirectoryChange(value: string): void;
}) {
  const { data } = useAppData();
  const { refresh, notify } = useAppActions();
  const { navigate } = useAppNavigation();
  const action = useOperationAction();
  const [selected, setSelected] = useState<string[]>([]);
  const [rights, setRights] = useState(false);
  const detail = model.detail.data!;
  const summary = detail.collection;
  const current = (summary?.driveType ?? "all") === model.driveType;
  const accounts = data!.accounts.filter(
    (a) => a.enabled && a.status === "connected",
  );
  const target = accounts.find((a) => a.id === targetAccount);
  useEffect(() => {
    setSelected([]);
    setRights(false);
  }, [model.id, model.driveType, targetAccount]);
  useEffect(() => {
    setRights(false);
  }, [directory]);
  return (
    <>
      <div className="collection-result-filter">
        <Field label="按网盘类型显示">
          <Select
            aria-label="按网盘类型显示"
            value={model.driveType}
            onValueChange={(value) =>
              model.setDriveType(value as CollectionDriveFilter)
            }
            items={[
              {
                value: "all",
                label: `全部结果${summary ? `（${summary.total}）` : ""}`,
              },
              ...collectionDriveTypes.map((type) => ({
                value: type,
                label: `${collectionDriveLabels[type]}${summary ? `（${summary.counts[type] ?? 0}）` : ""}`,
              })),
              {
                value: "unmatched",
                label: `未命中记录${summary ? `（${summary.counts.unmatched ?? 0}）` : ""}`,
              },
            ]}
          />
        </Field>
        <span>筛选整个任务的结果，切换类型后清空勾选。</span>
      </div>
      <div className="operations-transfer">
        <div className="operations-form-grid">
          <Field
            label="转存到本人网盘账号"
            hint="选择账号后，可勾选与账号相同网盘类型的资源。"
          >
            <Select
              value={targetAccount}
              onValueChange={onTargetChange}
              items={[
                { value: "", label: "选择已登录的网盘账号" },
                ...accounts.map((a) => ({
                  value: a.id,
                  label: `${a.alias} · ${providerSpecs[a.provider].name}`,
                })),
              ]}
            />
          </Field>
          <Field label="目标父目录">
            <input
              value={directory}
              onChange={(event) => onDirectoryChange(event.target.value)}
            />
          </Field>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={rights}
            onChange={(event) => setRights(event.target.checked)}
          />
          我有权保存和分享所选资源
        </label>
        <div className="operations-actions">
          <span>已选{selected.length}项 · 跨页保留，最多100项</span>
          {selected.length ? (
            <Button
              quiet
              onClick={() => {
                setSelected([]);
                setRights(false);
              }}
            >
              清空选择
            </Button>
          ) : null}
          <Button
            primary
            disabled={
              !selected.length ||
              !rights ||
              !target ||
              !directory.trim() ||
              !!action.pending ||
              model.running ||
              !current
            }
            onClick={() =>
              void action.run(
                "zhidao.collect.transfer",
                {
                  itemIds: selected,
                  accountId: targetAccount,
                  directory,
                  rightsConfirmed: true,
                },
                (result) => {
                  windowStorage.setItem("panxu-batch-id", result.batchId);
                  void refresh().catch(() =>
                    notify(
                      "资料已交给转存预检；列表刷新失败，请稍后刷新。",
                      "warning",
                    ),
                  );
                  navigate("batch");
                },
                "已交给现有批量预检",
              )
            }
          >
            检查并交给转存
          </Button>
        </div>
        <p className="operation-run-message">
          尚未接入转存的网盘可查看、复制和导出链接。搜索结果不代表链接已验活。
        </p>
      </div>
      {!current ? (
        <LoadingState label="正在按网盘类型读取结果…" compact />
      ) : detail.items.length ? (
        <ResultTable
          resourceCollection
          items={detail.items}
          selected={selected}
          selectable={(item) =>
            !!target &&
            !!item.link &&
            item.status === "ready" &&
            collectionTransferProvider(item.link) === target.provider
          }
          onSelect={(ids) => {
            setSelected(ids);
            setRights(false);
          }}
          running={model.running}
          onChanged={() => {
            setSelected([]);
            setRights(false);
            model.refresh();
          }}
        />
      ) : (
        <Empty title="此网盘类型暂无结果" compact>
          可切换到其他网盘类型，或选择“全部结果”查看采集记录。
        </Empty>
      )}
    </>
  );
}
