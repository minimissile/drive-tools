import { useEffect, useRef, useState } from "react";
import { ipc } from "../api/client";
import type { DriveDirectory } from "../../shared/drive-files";

/** Remote reads only run after an explicit directory action. */
export function useDriveDirectory(accountId: string, initialPath: string) {
  const [directory, setDirectory] = useState<DriveDirectory | null>(null);
  const [path, setPath] = useState(initialPath);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const serial = useRef(0);
  const mounted = useRef(true);
  const attempted = useRef(initialPath);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      serial.current++;
    };
  }, []);
  const read = async (next = directory?.path ?? path) => {
    const request = ++serial.current;
    attempted.current = next;
    setLoading(true);
    setError("");
    try {
      const value = await ipc("drive.directory", { accountId, path: next });
      if (!mounted.current || request !== serial.current) return false;
      setDirectory(value);
      setPath(value.path);
      return true;
    } catch (cause) {
      if (!mounted.current || request !== serial.current) return false;
      setError(
        cause instanceof Error ? cause.message : "目录读取失败，请重试。",
      );
      return false;
    } finally {
      if (mounted.current && request === serial.current) setLoading(false);
    }
  };
  return {
    directory,
    path,
    setPath,
    loading,
    error,
    read,
    retry: () => read(attempted.current),
    mounted,
  };
}
