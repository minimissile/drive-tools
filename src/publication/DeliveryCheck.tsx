import { QueryError } from "../ui/QueryError";
import { Select } from "../ui/Select";
import { ipc } from "../api/client";
import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import {
  deliveryStatuses,
  deliveryCheckIsStale,
  type PublicationDeliveryCheck,
} from "../../shared/publication-checks";
import {
  channelProfiles,
  linkPositionIds,
  linkPositionLabels,
  type LinkPosition,
} from "../../shared/channels";
import type { Platform, Publication } from "../../shared/types";
import { Button, Field, LoadingState, Notice, Panel } from "../ui/primitives";
import { formatTime } from "../lib/format";
import { useAppActions, useAppActivity } from "../state";

export default function DeliveryCheck({
  publication,
  platform,
  shareUrl,
  shareVersion,
  ownReady,
  ownerUid,
}: {
  publication: Publication;
  platform: Platform;
  shareUrl: string | null | undefined;
  shareVersion: number | undefined;
  ownReady: boolean;
  ownerUid: string | null;
}) {
  const { command } = useAppActions(),
    { busy } = useAppActivity();
  const [history, setHistory] = useState<PublicationDeliveryCheck[]>([]);
  const [loadError, setLoadError] = useState("");
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] =
    useState<PublicationDeliveryCheck["status"]>("not_provided");
  const [position, setPosition] = useState<LinkPosition>(
    channelProfiles[platform].positions[0] ?? "body",
  );
  const [note, setNote] = useState("");
  useEffect(() => {
    let active = true;
    setLoadError("");
    setLoaded(false);
    void ipc("publication.deliveryChecks", {
      publicationId: publication.id,
    })
      .then((rows) => {
        if (active) {
          setHistory(rows);
          setLoaded(true);
        }
      })
      .catch((error: Error) => {
        if (active) setLoadError(error.message);
      });
    return () => {
      active = false;
    };
  }, [publication.id, revision]);
  const latest = history[0],
    stale =
      latest &&
      deliveryCheckIsStale(latest, shareUrl, shareVersion, {
        ready: ownReady,
        ownerUid,
      });
  return (
    <Panel
      title="发布后资源入口验收"
      extra={<small>人工核验 · 本地留档</small>}
    >
      <Notice>
        请从实际文章进入资料入口，核对文件与保存功能，再记录结果。文章已发布与资料可获取分别记录。
      </Notice>
      {loadError ? (
        <QueryError
          error={loadError}
          title="验收历史暂未读取成功"
          onRetry={() => setRevision((v) => v + 1)}
        />
      ) : !loaded ? (
        <LoadingState label="正在读取验收记录…" compact />
      ) : latest ? (
        <Notice warning={stale || latest.status !== "verified"}>
          <strong className="delivery-check-status">
            {stale
              ? "此前验收已过期：本人分享、版本或归属状态已变化，请重新核对文章。"
              : `最近验收：${deliveryStatuses[latest.status]}`}
          </strong>
          <small>
            {formatTime(latest.checkedAt)} ·{" "}
            {latest.position
              ? linkPositionLabels[latest.position]
              : "无资料入口"}{" "}
            · {latest.note}
          </small>
        </Notice>
      ) : (
        <Notice warning>此文章尚未记录资源入口验收。</Notice>
      )}
      <Field label="本次验收结果">
        <Select
          aria-label="本次入口验收结果"
          value={status}
          onValueChange={(nextValue) => {
            setStatus(nextValue as typeof status);
          }}
          items={[
            ...Object.entries(deliveryStatuses).map(([value, label]) => ({
              value: value,
              label: label,
            })),
          ]}
        />
      </Field>
      {status !== "not_provided" ? (
        <Field label="文章实际使用的入口位置">
          <Select
            aria-label="实际资源入口位置"
            value={position}
            onValueChange={(nextValue) => {
              setPosition(nextValue as LinkPosition);
            }}
            items={[
              ...linkPositionIds.map((p) => ({
                value: p,
                label: (
                  <>
                    {linkPositionLabels[p]}
                    {channelProfiles[platform].positions.includes(p)
                      ? ""
                      : " · 非获准候选位置"}
                  </>
                ),
              })),
            ]}
          />
        </Field>
      ) : null}
      <Field
        label="验收说明"
        hint="至少10字，记录实际看到的文件、保存结果或失败原因"
      >
        <textarea
          aria-label="资源入口验收说明"
          value={note}
          maxLength={2000}
          onChange={(e) => {
            setNote(e.target.value);
          }}
          placeholder="例如：从文章阅读原文进入本人分享，文件与配套资料一致，保存入口可用。"
        />
      </Field>
      <Button
        disabled={!loaded || !!loadError || busy > 0 || note.trim().length < 10}
        onClick={async () => {
          const result = await command(
            "publication.deliveryCheck",
            {
              publicationId: publication.id,
              status,
              position: status === "not_provided" ? null : position,
              note,
              confirmed: true,
            },
            "入口验收已保存，文章发布状态保持不变。",
          );
          if (result) {
            setHistory((rows) => [result, ...rows].slice(0, 100));
          }
        }}
      >
        <Check size={14} />
        保存入口验收
      </Button>
      {history.length ? (
        <details className="delivery-check-history">
          <summary>历史验收（最近{history.length}条）</summary>
          {history.map((check) => (
            <div key={check.id} className="delivery-check-record">
              <strong>
                {deliveryStatuses[check.status]} ·{" "}
                {check.position ? linkPositionLabels[check.position] : "无入口"}
              </strong>
              <small>
                {formatTime(check.checkedAt)} · 草稿 v{check.draftVersion} ·
                本人分享 v{check.shareVersion}
              </small>
              <p>{check.note}</p>
            </div>
          ))}
        </details>
      ) : null}
    </Panel>
  );
}
