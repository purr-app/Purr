import type { SessionCookie } from "../features/request-workbench/model/cookie-jar";
import type { LocalChange, LocalStateStore } from "./contracts";

export interface CookieJarStore {
  load(workspaceId: string): Promise<SessionCookie[]>;
  replace(workspaceId: string, cookies: SessionCookie[]): Promise<void>;
}
// LocalStateStore's native boundary encrypts payloads; callers never manage keys
// or write plaintext cookie values directly to SQLite.
export class EncryptedCookieJarStore implements CookieJarStore {
  constructor(private local: LocalStateStore) {}
  async load(workspaceId: string) { return (await this.local.readLocal(workspaceId)).filter((record) => record.table === "cookie_jar").map((record) => record.value as SessionCookie); }
  async replace(workspaceId: string, cookies: SessionCookie[]) {
    const current = await this.load(workspaceId);
    const changes: LocalChange[] = cookies.map((cookie) => ({ table: "cookie_jar", id: cookie.id, value: cookie }));
    for (const cookie of current) if (!cookies.some((next) => next.id === cookie.id)) changes.push({ table: "cookie_jar", id: cookie.id, value: null });
    await this.local.writeLocal(workspaceId, changes);
  }
}
