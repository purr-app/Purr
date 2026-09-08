import { Cookie, CookieJar, MemoryCookieStore } from "tough-cookie";

export type SessionCookie = {
  id: string;
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: "strict" | "lax" | "none" | "";
  expires?: string;
  hostOnly: boolean;
  enabled: boolean;
};
const identity = (cookie: Cookie) =>
  JSON.stringify([cookie.domain, cookie.path, cookie.key]);

// Session-only storage: secrets never enter localStorage or request history.
export class SessionCookieJar {
  private store = new MemoryCookieStore();
  private jar = new CookieJar(this.store, {
    prefixSecurity: "strict",
    allowSecureOnLocal: false,
  });
  private disabled = new Set<string>();
  private listeners = new Set<() => void>();
  private version = 0;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getVersion = () => this.version;
  private changed() {
    this.version++;
    this.listeners.forEach((listener) => listener());
  }

  receive(url: string, headers: [string, string][]) {
    for (const [name, value] of headers) {
      if (name.toLowerCase() !== "set-cookie") continue;
      // Invalid / foreign-domain cookies must not break the HTTP response.
      try {
        const cookie = Cookie.parse(value);
        if (!cookie || (cookie.sameSite === "none" && !cookie.secure)) continue;
        this.jar.setCookieSync(cookie, url);
      } catch {
        /* rejected by cookie policy */
      }
    }
    this.changed();
  }
  header(url: string, sameSiteContext: "strict" | "lax" | "none" = "strict") {
    return this.jar
      .getCookiesSync(url, { http: true, sameSiteContext })
      .filter((cookie) => !this.disabled.has(identity(cookie)))
      .filter(
        (cookie) => sameSiteContext !== "none" || cookie.sameSite === "none",
      )
      .map((cookie) => cookie.cookieString())
      .join("; ");
  }
  list(): SessionCookie[] {
    const serialized = this.jar.serializeSync();
    return (serialized?.cookies ?? []).flatMap<SessionCookie>((data) => {
      const cookie = Cookie.fromJSON(data);
      if (!cookie || (cookie.expiryTime() ?? Infinity) <= Date.now()) return [];
      const expiry = new Date(cookie.expiryTime() ?? Infinity);
      return [
        {
          id: identity(cookie),
          name: cookie.key,
          value: cookie.value,
          domain: cookie.domain ?? "",
          path: cookie.path ?? "/",
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          sameSite:
            cookie.sameSite === "lax" ||
            cookie.sameSite === "strict" ||
            cookie.sameSite === "none"
              ? cookie.sameSite
              : "",
          hostOnly: Boolean(cookie.hostOnly),
          expires: Number.isFinite(expiry.getTime())
            ? expiry.toISOString()
            : undefined,
          enabled: !this.disabled.has(identity(cookie)),
        },
      ];
    });
  }
  toggle(id: string) {
    if (this.disabled.has(id)) this.disabled.delete(id);
    else this.disabled.add(id);
    this.changed();
  }
  async remove(id: string) {
    const [domain, path, key] = JSON.parse(id) as [string, string, string];
    await this.store.removeCookie(domain, path, key);
    this.disabled.delete(id);
    this.changed();
  }
  async save(value: Omit<SessionCookie, "id">, previousId?: string) {
    if (
      !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value.name) ||
      /[\x00-\x20\x7f;,]/.test(value.value)
    )
      throw new Error(
        "Enter a valid cookie name and value (encode spaces and special characters).",
      );
    if (!value.path.startsWith("/"))
      throw new Error("Cookie path must start with /.");
    if (value.sameSite === "none" && !value.secure)
      throw new Error("SameSite=None requires Secure.");
    const domain = value.domain.replace(/^\./, "");
    const url = new URL(
      `${value.secure ? "https" : "http"}://${domain}${value.path}`,
    );
    if (url.hostname !== domain || !domain || /[\s/:?#@]/.test(domain))
      throw new Error("Enter a hostname without a scheme or port.");
    const cookie = new Cookie({
      key: value.name,
      value: value.value,
      domain: value.hostOnly ? undefined : domain,
      path: value.path,
      secure: value.secure,
      httpOnly: value.httpOnly,
      sameSite: value.sameSite || undefined,
      expires: value.expires ? new Date(value.expires) : "Infinity",
    });
    const saved = this.jar.setCookieSync(cookie, url.toString());
    if (!saved) throw new Error("Cookie was rejected by the cookie policy.");
    const id = identity(saved);
    if (previousId && previousId !== id) await this.remove(previousId);
    if (value.enabled) this.disabled.delete(id);
    else this.disabled.add(id);
    this.changed();
  }
}
