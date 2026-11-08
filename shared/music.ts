/** Shared library: video and other callers only receive normalized, cached music. */
export interface MusicTrack {
  id: string;
  title: string;
  author: string;
  rank: number;
  durationSeconds?: number;
  audioCached: boolean;
}

export interface MusicLibraryState {
  configured: boolean;
  enabled: boolean;
  intervalDays: 7;
  updatedAt: string | null;
  lastAttemptAt: string | null;
  nextUpdateAt: string | null;
  updating: boolean;
  error: string | null;
  tracks: MusicTrack[];
}

export interface MusicAudio {
  name: string;
  src: string;
}

type Contract<A, V> = { args: A; value: V };
export interface MusicContract {
  /** Local only. Never sends a remote request. */
  "music.library": Contract<undefined, MusicLibraryState>;
  "music.configure": Contract<{ enabled: boolean }, MusicLibraryState>;
  /** Reuses this week's results; retry is allowed only after a failed attempt. */
  "music.update": Contract<{ retry?: boolean }, MusicLibraryState>;
  /** Explicit selection: downloads once, then reuses local audio. */
  "music.audio": Contract<{ id: string; retry?: boolean }, MusicAudio>;
}
