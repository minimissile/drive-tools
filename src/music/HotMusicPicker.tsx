import { useEffect, useRef, useState } from "react";
import { Music2, RefreshCw } from "lucide-react";
import type { MusicAudio, MusicLibraryState } from "../../shared/music";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { DataState } from "../ui/DataState";
import { QueryError } from "../ui/QueryError";
import { Button, Empty, Field, LoadingState } from "../ui/primitives";
import { Select } from "../ui/Select";
import "./music.css";

function dateLabel(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleString("zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}

/** Shared music chooser. Reads are local; paid work only follows named actions. */
export function HotMusicPicker({
  disabled = false,
  onSelect,
  onLoadingChange,
}: {
  disabled?: boolean;
  onSelect(audio: MusicAudio): void;
  onLoadingChange?(loading: boolean): void;
}) {
  const [open, setOpen] = useState(false);
  const library = useIpcQuery("music.library", undefined, {
    enabled: open,
    keepPrevious: true,
  });
  const [operation, setOperation] = useState("");
  const [actionError, setActionError] = useState("");
  const [audioFailures, setAudioFailures] = useState<Record<string, string>>(
    {},
  );
  const [selectedId, setSelectedId] = useState("");
  const mounted = useRef(true);
  const locked = useRef(false);
  const disabledNow = useRef(disabled);
  const loadingListener = useRef(onLoadingChange);
  const selectListener = useRef(onSelect);
  disabledNow.current = disabled;
  loadingListener.current = onLoadingChange;
  selectListener.current = onSelect;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      loadingListener.current?.(false);
    };
  }, []);

  const state = library.data;
  const selected =
    state?.tracks.find((track) => track.id === selectedId) ?? state?.tracks[0];
  const busy = !!operation || !!state?.updating;
  const unavailable = disabled || busy;
  const audioError = selected ? audioFailures[selected.id] : "";
  const updateError = actionError || state?.error || "";
  const update = async (
    name: string,
    action: () => Promise<MusicLibraryState>,
  ) => {
    if (locked.current || disabledNow.current) return;
    locked.current = true;
    setOperation(name);
    setActionError("");
    try {
      const next = await action();
      if (mounted.current) library.setData(next);
    } catch (cause) {
      if (mounted.current) {
        setActionError(
          cause instanceof Error ? cause.message : "音乐榜更新未完成。",
        );
        library.reload();
      }
    } finally {
      locked.current = false;
      if (mounted.current) setOperation("");
    }
  };
  const useAudio = async (retry: boolean) => {
    if (!selected || locked.current || disabledNow.current) return;
    const id = selected.id;
    locked.current = true;
    setOperation("audio");
    loadingListener.current?.(true);
    try {
      const audio = await ipc("music.audio", {
        id,
        ...(retry ? { retry } : {}),
      });
      if (!mounted.current) return;
      setAudioFailures((previous) => {
        const next = { ...previous };
        delete next[id];
        return next;
      });
      library.reload();
      if (!disabledNow.current) selectListener.current(audio);
    } catch (cause) {
      if (mounted.current)
        setAudioFailures((previous) => ({
          ...previous,
          [id]: cause instanceof Error ? cause.message : "配乐获取未完成。",
        }));
    } finally {
      locked.current = false;
      if (mounted.current) {
        setOperation("");
        loadingListener.current?.(false);
      }
    }
  };

  return (
    <details
      className="hot-music-picker"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>抖音热门配乐</summary>
      <div className="hot-music-body">
        {!state && library.loading ? (
          <LoadingState compact label="正在读取本地音乐库…" />
        ) : null}
        {library.error ? (
          <QueryError
            error={library.error}
            loading={library.loading}
            onRetry={library.reload}
            title="暂时无法读取热门配乐"
          />
        ) : null}
        {state ? (
          <>
            <div className="hot-music-toolbar">
              <span>
                {state.updatedAt
                  ? `更新于 ${dateLabel(state.updatedAt)}`
                  : "尚未获取音乐榜"}
              </span>
              <Button
                quiet
                size="compact"
                disabled={unavailable || (!state.configured && !state.enabled)}
                onClick={() =>
                  void update("configure", () =>
                    ipc("music.configure", { enabled: !state.enabled }),
                  )
                }
              >
                {state.enabled ? "暂停每周更新" : "启用每周更新"}
              </Button>
              {state.updatedAt && !updateError ? (
                <Button
                  quiet
                  size="compact"
                  disabled={unavailable || !state.configured}
                  onClick={() =>
                    void update("update", () => ipc("music.update", {}))
                  }
                >
                  <RefreshCw size={13} />
                  检查更新
                </Button>
              ) : null}
            </div>
            {state.enabled && state.nextUpdateAt ? (
              <p className="hot-music-meta">
                下次更新 {dateLabel(state.nextUpdateAt)}
                ；届时应用未运行，将在下次启动后更新。
              </p>
            ) : null}
            {!state.configured ? (
              <p className="hot-music-meta">
                请先在“连接与设置 → 内容数据源”保存 TikHub API Key。
              </p>
            ) : null}
            {busy && operation !== "audio" ? (
              <LoadingState compact label="正在更新热门音乐榜…" />
            ) : null}
            {updateError && !library.error ? (
              <DataState
                kind="error"
                compact
                title="音乐榜更新未完成"
                action={
                  <Button
                    size="compact"
                    disabled={unavailable || !state.configured}
                    onClick={() =>
                      void update("update", () =>
                        ipc("music.update", { retry: true }),
                      )
                    }
                  >
                    重试更新
                  </Button>
                }
              >
                {updateError}
              </DataState>
            ) : null}
            {state.tracks.length ? (
              <>
                <Field label="选择热门配乐">
                  <Select
                    aria-label="抖音热门配乐"
                    value={selected?.id}
                    disabled={unavailable}
                    onValueChange={setSelectedId}
                    items={state.tracks.map((track) => ({
                      value: track.id,
                      label: `${track.rank}. ${track.title}${track.author ? ` · ${track.author}` : ""}`,
                    }))}
                  />
                </Field>
                <div className="hot-music-actions">
                  <span>
                    {selected?.audioCached
                      ? "配乐已保存在本机"
                      : "首次使用会下载配乐，必要时查询 TikHub 音乐详情。"}
                  </span>
                  {!audioError ? (
                    <Button
                      size="compact"
                      disabled={
                        unavailable ||
                        (!selected?.audioCached && !state.configured)
                      }
                      onClick={() => void useAudio(false)}
                    >
                      <Music2 size={14} />
                      {operation === "audio"
                        ? "正在获取配乐…"
                        : selected?.audioCached
                          ? "使用本地配乐"
                          : "使用配乐"}
                    </Button>
                  ) : null}
                </div>
                {audioError ? (
                  <DataState
                    kind="error"
                    compact
                    title="配乐获取未完成"
                    action={
                      <Button
                        size="compact"
                        disabled={unavailable}
                        onClick={() => void useAudio(true)}
                      >
                        {operation === "audio"
                          ? "正在获取配乐…"
                          : "重试获取配乐"}
                      </Button>
                    }
                  >
                    {audioError}
                  </DataState>
                ) : null}
              </>
            ) : !state.updating && !updateError && !library.error ? (
              <Empty compact icon={Music2} title="本地还没有热门配乐">
                启用每周更新后获取榜单，制作视频时复用本地内容。
              </Empty>
            ) : null}
          </>
        ) : null}
        <p className="hot-music-note">
          榜单每 7 天更新，查询使用 TikHub
          额度；配乐下载后保存在本机。发布时按音乐授权范围使用。
        </p>
      </div>
    </details>
  );
}
