import { Cookie as CookieIcon, Pencil, Plus, Trash2 } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { Button } from "../../../shared/components/ui/button";
import { Checkbox } from "../../../shared/components/ui/checkbox";
import { FormField } from "../../../shared/components/ui/form-field";
import { SecretInput } from "../../../shared/components/ui/secret-input";
import { SelectField } from "../../../shared/components/ui/select-field";
import { cn } from "../../../shared/lib/cn";
import { SessionCookieJar, type SessionCookie } from "../model/cookie-jar";

export function CookieJarEditor({
  jar,
  url,
  enabled,
  onEnabledChange,
}: {
  jar: SessionCookieJar;
  url: string;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
}) {
  useSyncExternalStore(jar.subscribe, jar.getVersion);
  const [editing, setEditing] = useState<SessionCookie | null>(null);
  const [error, setError] = useState("");
  const cookies = jar.list();
  const add = () => {
    let domain = "";
    try {
      domain = new URL(url).hostname;
    } catch {
      /* URL may be a draft */
    }
    setError("");
    setEditing({
      id: "",
      name: "",
      value: "",
      domain,
      path: "/",
      secure: url.startsWith("https:"),
      httpOnly: true,
      sameSite: "lax",
      enabled: true,
      hostOnly: true,
    });
  };
  return (
    <div
      aria-label="Session cookie jar"
      className="space-y-ui-4 bg-purr-surface p-ui-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-ui-3">
        <div className="flex items-center gap-ui-2 text-ui-md">
          <CookieIcon className="size-ui-4 text-action-brand" />
          Session cookies
        </div>
        <div className="flex items-center gap-ui-4">
          <Checkbox
            checked={enabled}
            onCheckedChange={onEnabledChange}
            label="Use cookie jar"
          />
          <Button variant="secondary" size="sm" onClick={add}>
            <Plus className="size-ui-3" />
            Add cookie
          </Button>
        </div>
      </div>
      {cookies.length ? (
        <div className="space-y-ui-2">
          {cookies.map((cookie) => (
            <div
              key={cookie.id}
              className="flex flex-wrap items-center gap-ui-3 rounded-ui-lg bg-purr-elevated p-ui-2"
            >
              <Checkbox
                checked={cookie.enabled}
                onCheckedChange={() => jar.toggle(cookie.id)}
                label={`Enable ${cookie.name}`}
                hideLabel
              />
              <div
                className={cn(
                  "min-w-0 flex-1",
                  (!cookie.enabled || !enabled) && "opacity-ui-disabled",
                )}
              >
                <div className="font-code text-ui-sm text-syntax-property">
                  {cookie.name}
                </div>
                <div className="mt-ui-1 flex flex-wrap gap-x-ui-2 font-code text-ui-xs text-content-tertiary">
                  <span>
                    {cookie.domain}
                    {cookie.path}
                  </span>
                  {cookie.secure && <span>Secure</span>}
                  {cookie.httpOnly && <span>HttpOnly</span>}
                  {cookie.sameSite && <span>SameSite={cookie.sameSite}</span>}
                  <span>
                    {cookie.expires
                      ? new Date(cookie.expires).toLocaleString()
                      : "Session"}
                  </span>
                </div>
              </div>
              <SecretInput
                value={cookie.value}
                readOnly
                aria-label={`${cookie.name} cookie`}
                className={cn(
                  "min-w-0 flex-1",
                  (!cookie.enabled || !enabled) && "opacity-ui-disabled",
                )}
              />
              <Button
                size="icon"
                variant="ghost"
                aria-label={`Edit ${cookie.name}`}
                onClick={() => {
                  setEditing(cookie);
                  setError("");
                }}
              >
                <Pencil className="size-ui-3-5" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label={`Delete ${cookie.name}`}
                onClick={() => {
                  void jar.remove(cookie.id);
                  if (editing?.id === cookie.id) setEditing(null);
                }}
              >
                <Trash2 className="size-ui-3-5" />
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <p className="rounded-ui-lg bg-purr-elevated px-ui-4 py-ui-5 text-ui-sm text-content-secondary">
          No session cookies yet. Send a login request or add a cookie.
        </p>
      )}
      {editing ? (
        <form
          aria-label="Edit cookie"
          className="space-y-ui-4 rounded-ui-lg bg-purr-overlay p-ui-4"
          onSubmit={async (event) => {
            event.preventDefault();
            setError("");
            try {
              await jar.save(editing, editing.id || undefined);
              setEditing(null);
            } catch (cause) {
              setError(
                cause instanceof Error
                  ? cause.message
                  : "Could not save the cookie.",
              );
            }
          }}
        >
          <div className="grid gap-ui-4 sm:grid-cols-2">
            <FormField
              label="Cookie name"
              required
              value={editing.name}
              onChange={(event) =>
                setEditing({ ...editing, name: event.target.value })
              }
            />
            <FormField
              label="Cookie value"
              secret
              value={editing.value}
              onChange={(event) =>
                setEditing({ ...editing, value: event.target.value })
              }
            />
            <FormField
              label="Domain"
              required
              value={editing.domain}
              onChange={(event) =>
                setEditing({ ...editing, domain: event.target.value })
              }
            />
            <FormField
              label="Path"
              required
              value={editing.path}
              onChange={(event) =>
                setEditing({ ...editing, path: event.target.value })
              }
            />
            <div className="space-y-ui-2">
              <span className="block text-ui-xs text-content-secondary">
                SameSite
              </span>
              <SelectField
                label="Cookie SameSite"
                size="lg"
                value={editing.sameSite}
                onValueChange={(sameSite) =>
                  setEditing({ ...editing, sameSite })
                }
                options={[
                  { value: "", label: "Unspecified" },
                  { value: "lax", label: "Lax" },
                  { value: "strict", label: "Strict" },
                  { value: "none", label: "None (requires Secure)" },
                ]}
                className="w-full bg-purr-surface"
              />
            </div>
            <FormField
              label="Expires (UTC, optional)"
              type="datetime-local"
              value={editing.expires?.slice(0, 16) ?? ""}
              onChange={(event) =>
                setEditing({
                  ...editing,
                  expires: event.target.value
                    ? new Date(event.target.value + ":00Z").toISOString()
                    : undefined,
                })
              }
            />
          </div>
          <div className="flex flex-wrap items-center gap-ui-4">
            <Checkbox
              checked={editing.secure}
              onCheckedChange={(secure) => setEditing({ ...editing, secure })}
              label="Secure"
            />
            <Checkbox
              checked={editing.httpOnly}
              onCheckedChange={(httpOnly) =>
                setEditing({ ...editing, httpOnly })
              }
              label="HttpOnly"
            />
            <Checkbox
              checked={editing.hostOnly}
              onCheckedChange={(hostOnly) =>
                setEditing({ ...editing, hostOnly })
              }
              label="Host only"
            />
            <div className="ml-auto flex gap-ui-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setEditing(null)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                className="bg-action-brand text-content-primary hover:bg-action-brand-hover"
              >
                Save cookie
              </Button>
            </div>
          </div>
          {error && (
            <p role="alert" className="text-ui-sm text-accent-red">
              {error}
            </p>
          )}
        </form>
      ) : null}
    </div>
  );
}
