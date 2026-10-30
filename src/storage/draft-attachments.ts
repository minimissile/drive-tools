import { windowStorageKey } from "./window-storage";
// Large form attachments stay out of the small synchronous preference store.
let database: Promise<IDBDatabase> | undefined;
function open() {
  return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("panxu-form-attachments-v1", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("attachments");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      database = undefined;
      reject(request.error);
    };
  }));
}
export async function readAttachment(
  key: string,
): Promise<string | null | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const request = db
      .transaction("attachments")
      .objectStore("attachments")
      .get(windowStorageKey(key));
    request.onsuccess = () =>
      resolve(
        typeof request.result === "string" || request.result === null
          ? request.result
          : undefined,
      );
    request.onerror = () => reject(request.error);
  });
}
export async function writeAttachment(
  key: string,
  value: string | null | undefined,
) {
  const db = await open();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction("attachments", "readwrite");
    const store = transaction.objectStore("attachments");
    if (value === undefined) store.delete(windowStorageKey(key));
    else store.put(value, windowStorageKey(key));
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(transaction.error);
  });
}
