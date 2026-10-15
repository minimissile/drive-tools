import type { Database } from "./database";
import { AppError } from "./errors";
export interface SecretCodec {
  available(): boolean;
  encrypt(text: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
}
export class SecretStore {
  constructor(
    private db: Database,
    private codec: SecretCodec,
  ) {}
  has(key: string) {
    return !!this.db.get("SELECT key FROM secrets WHERE key=?", key);
  }
  async set(key: string, value: string) {
    if (!value.trim()) {
      this.remove(key);
      return;
    }
    if (!this.codec.available())
      throw new AppError(
        "ENCRYPTION_UNAVAILABLE",
        "系统加密服务不可用，未保存凭据。请检查钥匙串或系统凭据服务。",
      );
    const encrypted = await this.codec.encrypt(value.trim());
    this.db.run(
      "INSERT INTO secrets(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      key,
      encrypted,
    );
  }
  async get(key: string) {
    const row = this.db.get<{ value: string }>(
      "SELECT value FROM secrets WHERE key=?",
      key,
    );
    if (!row) return null;
    if (!this.codec.available())
      throw new AppError(
        "ENCRYPTION_UNAVAILABLE",
        "系统加密服务不可用，无法读取凭据。",
      );
    return this.codec.decrypt(row.value);
  }
  remove(key: string) {
    this.db.run("DELETE FROM secrets WHERE key=?", key);
  }
}
