import { id, type Database } from "../database";
import { AppError } from "../errors";
import { readLimited } from "../http";
import type { SecretStore } from "../secrets";
import type { MusicAudio, MusicLibraryState } from "../../shared/music";
import {
  parseMusicChart,
  parseMusicDetail,
  parseMusicJson,
  type StoredMusicTrack,
} from "./client";
import { downloadMusicAsset, readMusicAsset, type MusicAsset } from "./assets";
import { musicApiPaths, musicNetworkTarget } from "./network";

export const musicStateKey = "music:state:v1";
export const musicIntervalMs = 7 * 24 * 3600_000;
const ledger = "tikhub:music";
const credential = "pipix:tikhub";
const audioKey = (musicId: string) => `music:audio:${musicId}:v1`;
interface StoredState {
  enabled: boolean;
  updatedAt: string | null;
  lastAttemptAt: string | null;
  error: string | null;
  tracks: StoredMusicTrack[];
}
interface StoredAudio {
  track: StoredMusicTrack;
  asset?: MusicAsset;
  lastAttemptAt: string;
  error: string | null;
}
interface RawResponse {
  at: string;
  body: string;
  status: number;
}
const initialState = (): StoredState => ({
  enabled: false,
  updatedAt: null,
  lastAttemptAt: null,
  error: null,
  tracks: [],
});
const publicFailure = (error: unknown, fallback: string) =>
  error instanceof AppError && /^(?:MUSIC_|RESPONSE_TOO_LARGE)/.test(error.code)
    ? error.message.replace(/https?:\/\/[^\s"'<>]+/gi, "[音乐地址]")
    : fallback;

/** A restored backup never silently re-enables requests against a different Key. */
export function stopMusicForBackup(db: Database) {
  const stored = db.setting<StoredState | null>(musicStateKey, null);
  if (stored) db.setSetting(musicStateKey, { ...stored, enabled: false });
}

export interface MusicServiceDependencies {
  db: Database;
  dataPath: string;
  secrets: Pick<SecretStore, "has" | "get">;
  request?: (url: string, init: RequestInit) => Promise<Response>;
  changed(): void;
  clock?: () => number;
}

/** Shared hot-music library. Rendering never accesses TikHub or remote audio URLs. */
export class MusicService {
  private closed = false;
  private scheduling = false;
  private abort = new AbortController();
  private timer: ReturnType<typeof setInterval> | null = null;
  private refresh: Promise<MusicLibraryState> | null = null;
  private audioRequests = new Map<string, Promise<MusicAudio>>();
  constructor(private dependencies: MusicServiceDependencies) {
    // A parser update can recover an already-paid response without another request.
    const state = this.state();
    const raw = dependencies.db.setting<RawResponse | null>(
      "music:raw:chart:v1",
      null,
    );
    if (state.error && raw?.status === 200 && raw.at === state.lastAttemptAt) {
      try {
        const tracks = parseMusicChart(parseMusicJson(raw.body));
        this.store({ ...state, tracks, updatedAt: raw.at, error: null });
      } catch {
        /* Keep the original failure and weekly request limit. */
      }
    }
  }

  get isBusy() {
    return !!this.refresh || this.audioRequests.size > 0;
  }
  private at() {
    return (this.dependencies.clock ?? Date.now)();
  }
  private iso() {
    return new Date(this.at()).toISOString();
  }
  private state() {
    return this.dependencies.db.setting<StoredState>(
      musicStateKey,
      initialState(),
    );
  }
  private assertOpen() {
    if (this.closed) throw new AppError("MUSIC_CLOSED", "音乐库已关闭。");
  }
  private store(state: StoredState) {
    this.assertOpen();
    this.dependencies.db.setSetting(musicStateKey, state);
  }
  private changed() {
    if (!this.closed) this.dependencies.changed();
  }
  private due(at: string | null) {
    return !at || this.at() - Date.parse(at) >= musicIntervalMs;
  }

  library(): MusicLibraryState {
    this.assertOpen();
    const state = this.state();
    return {
      configured: this.dependencies.secrets.has(credential),
      enabled: state.enabled,
      intervalDays: 7,
      updatedAt: state.updatedAt,
      lastAttemptAt: state.lastAttemptAt,
      nextUpdateAt:
        state.enabled && state.lastAttemptAt
          ? new Date(
              Date.parse(state.lastAttemptAt) + musicIntervalMs,
            ).toISOString()
          : null,
      updating: !!this.refresh,
      error: state.error,
      tracks: state.tracks.map(({ audioUrls: _audioUrls, ...track }) => ({
        ...track,
        audioCached: !!this.dependencies.db.setting<StoredAudio | null>(
          audioKey(track.id),
          null,
        )?.asset,
      })),
    };
  }

  async configure({ enabled }: { enabled: boolean }) {
    this.assertOpen();
    if (typeof enabled !== "boolean")
      throw new AppError("MUSIC_INPUT", "音乐更新设置无效。");
    this.store({ ...this.state(), enabled });
    this.changed();
    this.start(enabled);
    return enabled ? this.update() : this.library();
  }

  /** Called by the app lifecycle, never by an automatic read hook. */
  start(active = true) {
    if (this.closed) return;
    this.scheduling = active;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!active) return;
    const tick = () => {
      if (
        this.closed ||
        !this.scheduling ||
        !this.state().enabled ||
        !this.dependencies.secrets.has(credential)
      )
        return;
      if (this.due(this.state().lastAttemptAt))
        void this.update().catch(() => {});
    };
    this.timer = setInterval(tick, 3600_000);
    this.timer.unref?.();
    queueMicrotask(tick);
  }

  update({
    retry = false,
  }: { retry?: boolean } = {}): Promise<MusicLibraryState> {
    this.assertOpen();
    if (this.refresh) return this.refresh;
    const state = this.state();
    if (!this.due(state.lastAttemptAt) && !(retry && state.error))
      return Promise.resolve(this.library());
    this.refresh = this.refreshChart().finally(() => {
      this.refresh = null;
      this.changed();
    });
    this.changed();
    return this.refresh;
  }

  private async refreshChart(): Promise<MusicLibraryState> {
    try {
      const key = await this.key();
      this.store({
        ...this.state(),
        lastAttemptAt: this.iso(),
        error: "上次热门音乐更新未完成，旧缓存保留；请显式重试。",
      });
      this.changed();
      const payload = await this.apiRequest(
        "chart",
        new URLSearchParams({ chart_type: "hot", cursor: "0" }),
        key,
      );
      const tracks = parseMusicChart(payload);
      this.store({
        ...this.state(),
        updatedAt: this.state().lastAttemptAt,
        error: null,
        tracks,
      });
      return { ...this.library(), updating: false };
    } catch (error) {
      if (this.closed) throw new AppError("MUSIC_CLOSED", "音乐库已关闭。");
      const message = publicFailure(
        error,
        "热门音乐更新未完成，旧缓存保留；服务端可能已处理并计费，不会自动重试。",
      );
      this.store({ ...this.state(), error: message });
      throw new AppError("MUSIC_UPDATE", message);
    }
  }

  audio({
    id: musicId,
    retry = false,
  }: {
    id: string;
    retry?: boolean;
  }): Promise<MusicAudio> {
    this.assertOpen();
    if (!/^\d{1,30}$/.test(musicId))
      throw new AppError("MUSIC_INPUT", "所选音乐ID无效。");
    const existing = this.audioRequests.get(musicId);
    if (existing) return existing;
    const operation = this.loadAudio(musicId, retry).finally(() => {
      this.audioRequests.delete(musicId);
      this.changed();
    });
    this.audioRequests.set(musicId, operation);
    this.changed();
    return operation;
  }

  private async loadAudio(
    musicId: string,
    retry: boolean,
  ): Promise<MusicAudio> {
    const { db, dataPath } = this.dependencies;
    let stored = db.setting<StoredAudio | null>(audioKey(musicId), null);
    const track =
      this.state().tracks.find((item) => item.id === musicId) ?? stored?.track;
    if (!track)
      throw new AppError(
        "MUSIC_NOT_FOUND",
        "该歌曲尚未收录，请先更新热门音乐。",
      );
    if (stored?.asset) {
      try {
        const src = await readMusicAsset(dataPath, stored.asset);
        this.assertOpen();
        return { name: this.name(track), src };
      } catch {
        this.assertOpen();
        stored = {
          ...stored,
          asset: undefined,
          error: "本地配乐缓存不可用或已被修改，请显式重试重新获取。",
        };
        db.setSetting(audioKey(musicId), stored);
        if (!retry) throw new AppError("MUSIC_CACHE", stored.error!);
      }
    }
    if (stored?.error && !retry && !this.due(stored.lastAttemptAt))
      throw new AppError("MUSIC_AUDIO", stored.error);
    const attemptedAt = this.iso();
    try {
      this.assertOpen();
      db.setSetting(audioKey(musicId), {
        track,
        lastAttemptAt: attemptedAt,
        error: "上次配乐获取未完成，请显式重试。",
      } satisfies StoredAudio);
      let source = track;
      // Re-fetch only to resolve a missing/previously failed URL. Cached audio skips this entirely.
      if (!source.audioUrls.length || !!stored?.error) {
        const raw = db.setting<RawResponse | null>(
          `music:raw:detail:${musicId}:v1`,
          null,
        );
        let localDetail: StoredMusicTrack | null = null;
        const expiredUrl = /配乐下载未成功（HTTP (?:403|404|410)）/.test(
          stored?.error ?? "",
        );
        if (!expiredUrl && raw?.status === 200 && !this.due(raw.at)) {
          try {
            localDetail = parseMusicDetail(parseMusicJson(raw.body), musicId);
          } catch {
            /* Do not assume malformed data is a usable URL. */
          }
        }
        source =
          localDetail ??
          parseMusicDetail(
            await this.apiRequest(
              "detail",
              new URLSearchParams({ music_id: musicId }),
              await this.key(),
            ),
            musicId,
          );
      }
      const signal = AbortSignal.any([
        this.abort.signal,
        AbortSignal.timeout(45_000),
      ]);
      const asset = await downloadMusicAsset(
        dataPath,
        source.audioUrls,
        this.request,
        signal,
      );
      this.assertOpen();
      const src = await readMusicAsset(dataPath, asset);
      this.assertOpen();
      db.setSetting(audioKey(musicId), {
        track: source,
        asset,
        lastAttemptAt: attemptedAt,
        error: null,
      } satisfies StoredAudio);
      return { name: this.name(source), src };
    } catch (error) {
      if (this.closed) throw new AppError("MUSIC_CLOSED", "音乐库已关闭。");
      const message = publicFailure(
        error,
        "配乐获取未完成，未自动重试；可稍后显式重试。",
      );
      db.setSetting(audioKey(musicId), {
        track,
        lastAttemptAt: attemptedAt,
        error: message,
      } satisfies StoredAudio);
      throw new AppError("MUSIC_AUDIO", message);
    }
  }

  private name(track: StoredMusicTrack) {
    return `${track.title}${track.author ? ` · ${track.author}` : ""}`;
  }
  private request = (url: string, init: RequestInit) => {
    const target = musicNetworkTarget(url, init.method);
    return (this.dependencies.request ?? fetch)(target.href, init);
  };
  private async key() {
    const value = await this.dependencies.secrets.get(credential);
    this.assertOpen();
    if (!value)
      throw new AppError(
        "MUSIC_KEY",
        "请先在内容数据源设置中保存 TikHub API Key。",
      );
    return value;
  }

  private async apiRequest(
    kind: keyof typeof musicApiPaths,
    query: URLSearchParams,
    key: string,
  ) {
    const { db } = this.dependencies;
    this.assertOpen();
    const requestId = id("api");
    const at =
      kind === "chart"
        ? (this.state().lastAttemptAt ?? this.iso())
        : this.iso();
    db.transaction(() => {
      const since = new Date(this.at() - 24 * 3600_000).toISOString();
      const used =
        db.get<{ count: number }>(
          "SELECT COUNT(*) count FROM api_calls WHERE endpoint=? AND created_at>=?",
          ledger,
          since,
        )?.count ?? 0;
      if (used >= 25)
        throw new AppError(
          "MUSIC_LIMIT",
          "已到音乐库最近24小时25次 TikHub 请求上限，本地配乐仍可使用。",
        );
      db.run(
        "INSERT INTO api_calls(id,endpoint,phase,units,status,created_at) VALUES(?,?,?,1,'reserved',?)",
        requestId,
        ledger,
        kind,
        at,
      );
    });
    let status: number | undefined;
    let received = false;
    try {
      const response = await this.request(
        `https://api.tikhub.io${musicApiPaths[kind]}?${query}`,
        {
          method: "GET",
          credentials: "omit",
          redirect: "error",
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.any([
            this.abort.signal,
            AbortSignal.timeout(45_000),
          ]),
        },
      );
      status = response.status;
      const body = (await readLimited(response, 4_000_000)).replaceAll(
        key,
        "[凭据已隐藏]",
      );
      this.assertOpen();
      db.setSetting(
        kind === "chart"
          ? "music:raw:chart:v1"
          : `music:raw:detail:${query.get("music_id")}:v1`,
        { body, status, at } satisfies RawResponse,
      );
      received = true;
      if (!response.ok)
        throw new AppError(
          "MUSIC_API",
          `TikHub 音乐请求未成功（HTTP ${status}），不会自动重试。`,
        );
      const payload = parseMusicJson(body);
      // Validate before recording a successful data request.
      if (kind === "chart") parseMusicChart(payload);
      else parseMusicDetail(payload, query.get("music_id")!);
      db.run(
        "UPDATE api_calls SET status='success',message=? WHERE id=?",
        `HTTP ${status}，金额以 TikHub 结算为准`,
        requestId,
      );
      return payload;
    } catch (error) {
      if (!this.closed)
        db.run(
          "UPDATE api_calls SET status=?,message=? WHERE id=?",
          received ? "error" : "uncertain",
          received
            ? "响应已归档但未获得可用音乐；金额以TikHub结算为准"
            : "响应未完整保存，保留请求记录，不自动重试",
          requestId,
        );
      throw error;
    }
  }

  close() {
    if (this.closed) return;
    this.dependencies.db.run(
      "UPDATE api_calls SET status='uncertain',message='音乐请求被中断，可能已计费，不自动重试' WHERE endpoint=? AND status='reserved'",
      ledger,
    );
    this.closed = true;
    this.scheduling = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.abort.abort();
  }
}
