import {
  Braces,
  Check,
  ChevronDown,
  Clock3,
  Cookie as CookieIcon,
  Copy,
  Eye,
  EyeOff,
  FlaskConical,
  GitBranch,
  Globe2,
  Search,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "../../../shared/components/ui/button";
import { AutocompleteInput } from "../../../shared/components/ui/autocomplete-input";
import { JsonCodePreview } from "../../../shared/components/ui/json-code-preview";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "../../../shared/components/ui/popover";
import { SelectField } from "../../../shared/components/ui/select-field";
import { cn } from "../../../shared/lib/cn";
import { formatPayloadSize } from "../model/request-body";
import {
  formatResponseBody,
  getResponseCookies,
  getResponseQuerySuggestions,
  inspectResponseBody,
  queryResponseJson,
  type ResponseQueryLanguage,
  type ResponseViewMode,
} from "../model/response";
import type { HttpResult } from "../services/http-client";
import { ResponseCodeViewer } from "./response-code-viewer";

type ResponseTab =
  | "response"
  | "headers"
  | "cookie"
  | "timeline"
  | "trace"
  | "bench";

const responseTabs: readonly {
  value: ResponseTab;
  label: string;
  icon?: LucideIcon;
  disabled?: boolean;
}[] = [
  { value: "response", label: "Response" },
  { value: "headers", label: "Headers" },
  { value: "cookie", label: "Cookie", icon: CookieIcon },
  { value: "timeline", label: "Timeline", icon: Clock3 },
  { value: "trace", label: "Trace", icon: GitBranch, disabled: true },
  { value: "bench", label: "Bench", icon: FlaskConical, disabled: true },
];

const responseViewModes: readonly {
  value: ResponseViewMode;
  label: string;
}[] = [
  { value: "pretty", label: "Pretty" },
  { value: "raw", label: "Raw" },
  { value: "hex", label: "Hex" },
  { value: "base64", label: "Base64" },
];

const queryLanguages: readonly {
  value: ResponseQueryLanguage;
  label: string;
}[] = [
  { value: "jq", label: "jq" },
  { value: "jsonpath", label: "JSONPath" },
];

function statusClass(status: number) {
  if (status < 300) return "text-status-success";
  if (status < 400) return "text-status-redirect";
  if (status < 500) return "text-status-client-error";
  return "text-status-server-error";
}

function CopyResponseButton({
  value,
  label,
}: {
  value: string;
  label: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      aria-label={label}
      disabled={!value}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1800);
        } catch {
          /* The selectable read-only viewer remains the clipboard fallback. */
        }
      }}
    >
      {copied ? (
        <Check className="size-ui-3" aria-hidden="true" />
      ) : (
        <Copy className="size-ui-3" aria-hidden="true" />
      )}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

function ResponseBodyPanel({ response }: { response: HttpResult }) {
  const info = useMemo(
    () => inspectResponseBody(response.headers, response.text),
    [response.headers, response.text],
  );
  const [mode, setMode] = useState<ResponseViewMode>(
    info.kind === "binary" ? "hex" : "pretty",
  );
  const [queryLanguage, setQueryLanguage] =
    useState<ResponseQueryLanguage>("jq");
  const [query, setQuery] = useState("");
  useEffect(() => {
    setMode(info.kind === "binary" ? "hex" : "pretty");
    setQuery("");
  }, [info.kind, response]);

  const queryResult = useMemo(() => {
    if (!query.trim() || info.parsedJson === undefined)
      return { value: undefined, error: "" };
    try {
      return {
        value: queryResponseJson(info.parsedJson, query, queryLanguage),
        error: "",
      };
    } catch (cause) {
      return {
        value: undefined,
        error:
          cause instanceof Error ? cause.message : "Invalid response query.",
      };
    }
  }, [info.parsedJson, query, queryLanguage]);
  const querySuggestions = useMemo(
    () =>
      info.parsedJson === undefined
        ? []
        : getResponseQuerySuggestions(info.parsedJson, queryLanguage),
    [info.parsedJson, queryLanguage],
  );
  const content = useMemo(
    () =>
      formatResponseBody(
        response,
        info,
        mode,
        queryResult.error ? undefined : queryResult.value,
      ),
    [info, mode, queryResult.error, queryResult.value, response],
  );
  const language =
    mode === "raw" || mode === "hex" || mode === "base64"
      ? "text"
      : queryResult.value !== undefined || info.kind === "json"
        ? "json"
        : info.kind === "xml" || info.kind === "html"
          ? "xml"
          : "text";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-ui-2 border-b border-border-subtle bg-purr-surface p-ui-2">
        <div className="flex min-w-0 flex-wrap items-center gap-ui-2">
          <span className="rounded-ui-md bg-action-brand-surface px-ui-2 py-ui-1 font-code text-ui-xs font-medium text-action-brand">
            {info.label}
          </span>
          <span className="max-w-full truncate font-code text-ui-xs text-content-tertiary">
            {info.mediaType}
          </span>
          <div className="flex items-center gap-ui-1 rounded-ui-md bg-purr-elevated p-ui-1">
            {responseViewModes.map((option) => (
              <Button
                key={option.value}
                type="button"
                size="xs"
                variant="ghost"
                weight="normal"
                aria-pressed={mode === option.value}
                className={cn(
                  mode === option.value
                    ? "bg-purr-highlight text-content-primary"
                    : "text-content-tertiary",
                )}
                onClick={() => setMode(option.value)}
              >
                {option.label}
              </Button>
            ))}
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-ui-2">
          {info.parsedJson !== undefined ? (
            <>
              <SelectField
                value={queryLanguage}
                options={queryLanguages}
                onValueChange={(language) => {
                  setQueryLanguage(language);
                  setQuery("");
                }}
                label="Response query language"
                className="w-method-popover font-code"
              />
              <AutocompleteInput
                label={`${queryLanguage} response query`}
                value={query}
                options={querySuggestions}
                placeholder={
                  queryLanguage === "jq"
                    ? ".users[0].name"
                    : "$.users[0].name"
                }
                icon={<Search className="size-ui-3" aria-hidden="true" />}
                className="flex-1 sm:max-w-validation-popover"
                inputClassName="h-control-sm rounded-ui-md bg-purr-elevated pr-ui-2 font-code text-ui-sm"
                onValueChange={(value) => {
                  setQuery(value);
                  if (value) setMode("pretty");
                }}
              />
            </>
          ) : null}
          <CopyResponseButton value={content} label="Copy response body" />
        </div>
      </div>
      {queryResult.error ? (
        <p
          role="alert"
          className="m-ui-0 border-b border-border-subtle px-ui-3 py-ui-2 font-code text-ui-xs text-accent-orange"
        >
          {queryResult.error}
        </p>
      ) : query.trim() && queryResult.value !== undefined ? (
        <p
          role="status"
          className="m-ui-0 border-b border-border-subtle px-ui-3 py-ui-2 font-code text-ui-xs text-action-brand"
        >
          Showing filtered result.
        </p>
      ) : null}
      <div className="min-h-0 flex-1">
        <ResponseCodeViewer value={content} language={language} />
      </div>
    </div>
  );
}

function ResponseHeadersPanel({ response }: { response: HttpResult }) {
  const text = response.headers
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
  return (
    <div className="h-full overflow-auto p-ui-3">
      <div className="mb-ui-2 flex items-center justify-between">
        <span className="font-code text-ui-xs text-content-tertiary">
          {response.headers.length} response headers
        </span>
        <CopyResponseButton value={text} label="Copy response headers" />
      </div>
      <div className="overflow-hidden rounded-ui-lg border border-border-subtle bg-purr-codefield">
        {response.headers.length ? (
          response.headers.map(([name, value], index) => (
            <div
              key={`${name}-${index}`}
              className="grid min-w-0 gap-ui-1 border-b border-border-subtle px-ui-3 py-ui-2 last:border-b-0 sm:grid-cols-3 sm:gap-ui-4"
            >
              <span className="min-w-0 flex-1 font-code text-ui-sm text-syntax-property">
                {name}
              </span>
              <ResponseHeaderValue name={name} value={value} />
            </div>
          ))
        ) : (
          <p className="m-ui-0 px-ui-3 py-ui-4 text-ui-sm text-content-tertiary">
            No response headers.
          </p>
        )}
      </div>
    </div>
  );
}

function ResponseHeaderValue({ name, value }: { name: string; value: string }) {
  const [expanded, setExpanded] = useState(false);
  const jsonValue = useMemo(() => {
    const trimmed = value.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return parsed && typeof parsed === "object" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }, [value]);
  return (
    <div className="min-w-0 sm:col-span-2">
      <div className="flex min-w-0 items-start gap-ui-2">
        <span className="min-w-0 flex-1 break-all font-code text-ui-sm text-content-secondary">
          {value}
        </span>
        {jsonValue !== undefined ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            aria-label={`${expanded ? "Hide" : "Format"} JSON value for ${name}`}
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            <Braces className="size-ui-3 text-action-brand" aria-hidden="true" />
            JSON
            <ChevronDown
              className={cn(
                "size-ui-3 transition-transform duration-ui-fast",
                expanded && "rotate-180",
              )}
              aria-hidden="true"
            />
          </Button>
        ) : null}
      </div>
      {expanded && jsonValue !== undefined ? (
        <div className="mt-ui-2 overflow-hidden rounded-ui-lg border border-border-subtle">
          <JsonCodePreview value={jsonValue} label={`${name} header JSON`} />
        </div>
      ) : null}
    </div>
  );
}

function ResponseCookiesPanel({ response }: { response: HttpResult }) {
  const cookies = useMemo(
    () => getResponseCookies(response.headers),
    [response.headers],
  );
  return (
    <div className="h-full min-h-0 overflow-auto bg-purr-surface p-ui-3">
      {cookies.length ? (
        <div className="flex flex-col gap-ui-2">
          {cookies.map((cookie, index) => (
            <ResponseCookieRow
              key={`${cookie.name}-${index}`}
              cookie={cookie}
            />
          ))}
        </div>
      ) : (
        <div className="flex h-full items-center justify-center px-ui-4 py-ui-6 text-center text-ui-sm text-content-tertiary">
          This response did not set any cookies.
        </div>
      )}
    </div>
  );
}

function ResponseCookieRow({
  cookie,
}: {
  cookie: ReturnType<typeof getResponseCookies>[number];
}) {
  const [expanded, setExpanded] = useState(false);
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const name = cookie.name || "Unnamed cookie";
  const shownValue = cookie.value ? (visible ? cookie.value : "••••••••") : '""';

  return (
    <div className="overflow-hidden rounded-ui-lg border border-border-subtle bg-purr-codefield">
      <div className="flex min-w-0 items-center gap-ui-1 px-ui-2 py-ui-1">
        <button
          type="button"
          aria-label={`${expanded ? "Hide" : "Show"} ${name} cookie attributes`}
          aria-expanded={expanded}
          className="ui-focus-ring flex h-control-md min-w-0 flex-1 items-center gap-ui-2 rounded-ui-md px-ui-1 text-left hover:bg-purr-highlight"
          onClick={() => setExpanded(!expanded)}
        >
          <ChevronDown
            className={cn(
              "size-ui-3 shrink-0 text-content-tertiary transition-transform duration-ui-fast",
              expanded ? "rotate-180" : "-rotate-90",
            )}
            aria-hidden="true"
          />
          <span className="min-w-0 truncate font-code text-ui-sm text-syntax-property">
            {name}
          </span>
          <span className="shrink-0 font-code text-ui-sm text-content-quaternary">
            =
          </span>
          <span className="min-w-0 flex-1 truncate font-code text-ui-sm text-content-secondary">
            {shownValue}
          </span>
        </button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={`${visible ? "Hide" : "Reveal"} ${name} cookie value`}
          aria-pressed={visible}
          onClick={() => setVisible(!visible)}
        >
          {visible ? (
            <EyeOff className="size-ui-4" aria-hidden="true" />
          ) : (
            <Eye className="size-ui-4" aria-hidden="true" />
          )}
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={`Copy ${name} cookie value`}
          disabled={!cookie.value}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(cookie.value);
              setCopied(true);
              clearTimeout(timer.current);
              timer.current = setTimeout(() => setCopied(false), 1800);
            } catch {
              /* Revealing the value remains the clipboard fallback. */
            }
          }}
        >
          {copied ? (
            <Check className="size-ui-4 text-action-brand" aria-hidden="true" />
          ) : (
            <Copy className="size-ui-4" aria-hidden="true" />
          )}
        </Button>
      </div>
      {expanded ? (
        <div className="border-t border-border-subtle px-ui-3 py-ui-2">
          <span className="text-ui-xs text-content-tertiary">Attributes</span>
          <p className="mb-ui-0 mt-ui-1 break-all font-code text-ui-xs text-content-secondary">
            {cookie.attributes.join(" · ") || "Session cookie"}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function connectionTarget(url: string) {
  try {
    const parsed = new URL(url);
    const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    return `${parsed.hostname}:${port}`;
  } catch {
    return url;
  }
}

function maskedHeader(name: string, value: string) {
  const normalized = name.toLowerCase();
  if (normalized === "authorization")
    return `${value.split(/\s+/, 1)[0] || "Token"} ••••••••`;
  if (normalized === "cookie")
    return value.replace(/(^|;\s*)([^=;]+)=([^;]*)/g, "$1$2=••••••••");
  if (normalized === "set-cookie") {
    const attributesAt = value.indexOf(";");
    const pair = attributesAt < 0 ? value : value.slice(0, attributesAt);
    const separator = pair.indexOf("=");
    return separator < 0
      ? value
      : `${pair.slice(0, separator)}=••••••••${
          attributesAt < 0 ? "" : value.slice(attributesAt)
        }`;
  }
  if (normalized.includes("api-key") || normalized === "x-auth-token")
    return "••••••••";
  return value;
}

function ResponseTimelinePanel({ response }: { response: HttpResult }) {
  const { timeline } = response;
  const [showBreakdown, setShowBreakdown] = useState(false);
  const isSecure = timeline.request.url.startsWith("https:");
  const phases = [
    {
      label: "Prepare",
      duration: timeline.prepareMs,
      className: "bg-accent-slate",
    },
    {
      label: "Connection + TTFB",
      duration: timeline.waitingMs,
      className: "bg-accent-orange",
    },
    {
      label: "Download",
      duration: timeline.downloadMs,
      className: "bg-accent-emerald",
    },
  ];
  return (
    <div className="ui-focus-ring h-full min-h-0 space-y-ui-3 overflow-auto bg-purr-surface p-ui-3" aria-label="Response timeline" tabIndex={0}>
      <div className="rounded-ui-lg border border-border-subtle bg-purr-codefield p-ui-3">
        <div className="mb-ui-3 flex flex-wrap items-center justify-between gap-ui-2">
          <div className="flex flex-wrap items-center gap-x-ui-4 gap-y-ui-1">
            {phases.map((phase) => (
              <span
                key={phase.label}
                className="flex items-center gap-ui-1 font-code text-ui-xs text-content-secondary"
              >
                <span
                  className={cn("size-ui-2 rounded-full", phase.className)}
                  aria-hidden="true"
                />
                {phase.label} ({phase.duration} ms)
              </span>
            ))}
          </div>
          <div className="flex items-center gap-ui-2">
            <span className="font-code text-ui-xs font-medium text-content-primary">
              {response.durationMs} ms total
            </span>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              aria-expanded={showBreakdown}
              aria-controls="response-time-waterfall"
              onClick={() => setShowBreakdown(!showBreakdown)}
            >
              {showBreakdown ? "Hide breakdown" : "Show breakdown"}
              <ChevronDown
                className={cn(
                  "size-ui-3 transition-transform duration-ui-fast",
                  showBreakdown && "rotate-180",
                )}
                aria-hidden="true"
              />
            </Button>
          </div>
        </div>
        <div
          className="flex h-ui-2 overflow-hidden rounded-ui-md bg-purr-elevated"
          aria-label="Response time breakdown"
        >
          {phases.map((phase) => (
            <span
              key={phase.label}
              className={cn("min-w-ui-1", phase.className)}
              style={{ flexBasis: 0, flexGrow: Math.max(phase.duration, 1) }}
              title={`${phase.label}: ${phase.duration} ms`}
            />
          ))}
        </div>
        {showBreakdown ? (
          <div
            id="response-time-waterfall"
            className="mt-ui-3 flex flex-col gap-ui-1"
            aria-label="Response time waterfall"
          >
            {phases.map((phase, index) => {
              const start = phases
                .slice(0, index)
                .reduce((total, entry) => total + entry.duration, 0);
              const scale = Math.max(response.durationMs, 1);
              return (
                <div key={phase.label} className="flex items-center gap-ui-2">
                  <span className="w-method-popover shrink-0 font-code text-ui-xs text-content-tertiary">
                    {phase.label}
                  </span>
                  <span className="relative h-control-xs min-w-0 flex-1 overflow-hidden rounded-ui-sm bg-purr-elevated">
                    <span
                      className={cn(
                        "absolute inset-y-0 min-w-ui-1 rounded-ui-sm",
                        phase.className,
                      )}
                      style={{
                        left: `${(start / scale) * 100}%`,
                        width: `${
                          (Math.max(phase.duration, 1) / scale) * 100
                        }%`,
                      }}
                    />
                  </span>
                  <span className="w-method-popover shrink-0 text-right font-code text-ui-xs text-content-secondary">
                    {phase.duration} ms
                  </span>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
      <div
        className="break-words rounded-ui-lg border border-border-subtle bg-purr-codefield p-ui-4 font-code text-ui-sm"
        aria-label="Network timeline log"
      >
        <div className="mb-ui-5 text-accent-orange">
          <p className="m-ui-0 font-medium">
            Preparing request to {timeline.request.url}
          </p>
          <p className="m-ui-0">
            Current time is {new Date(timeline.startedAtMs).toISOString()}
          </p>
        </div>

        <div className="mb-ui-5">
          <p className="m-ui-0 break-all text-action-brand">
            {timeline.request.method} {timeline.request.url}
          </p>
          <div className="mt-ui-3 text-content-secondary">
            {timeline.request.headers.length ? (
              timeline.request.headers.map(([name, value], index) => (
                <p key={`request-${name}-${index}`} className="m-ui-0 break-all">
                  {name}: {maskedHeader(name, value)}
                </p>
              ))
            ) : (
              <p className="m-ui-0 text-content-quaternary">
                No explicit request headers
              </p>
            )}
          </div>
        </div>

        <div className="mb-ui-5 text-accent-orange">
          <p className="m-ui-0">
            Redirects: {timeline.followRedirects ? "enabled" : "disabled"}
          </p>
          <p className="m-ui-0">Timeout: {timeline.timeoutMs} ms</p>
          <p className="m-ui-0">
            TLS validation: {isSecure ? "enabled" : "not applicable"}
          </p>
          <p className="m-ui-0">
            Cookie jar: {timeline.usesCookieJar ? "enabled" : "disabled"}
          </p>
        </div>

        <div className="mb-ui-5 text-accent-violet">
          <p className="m-ui-0">
            Connecting to {connectionTarget(timeline.request.url)}...
          </p>
          {response.remoteAddress ? (
            <p className="m-ui-0">Remote address: {response.remoteAddress}</p>
          ) : null}
          {response.localAddress ? (
            <p className="m-ui-0">Local address: {response.localAddress}</p>
          ) : null}
          <p className="m-ui-0">
            Negotiated protocol: {response.httpVersion || "HTTP"}
          </p>
          {isSecure ? (
            <p className="m-ui-0">TLS certificate verification enabled</p>
          ) : null}
        </div>

        <div>
          <p className={cn("m-ui-0 font-medium", statusClass(response.status))}>
            {response.httpVersion || "HTTP"} {response.status} {response.statusText}
          </p>
          <div className="mt-ui-3 text-content-secondary">
            {response.headers.map(([name, value], index) => (
              <p key={`response-${name}-${index}`} className="m-ui-0 break-all">
                {name}: {maskedHeader(name, value)}
              </p>
            ))}
          </div>
          <p className="mb-ui-0 mt-ui-3 text-accent-emerald">
            Response body received ({formatPayloadSize(response.size)})
          </p>
        </div>
      </div>
    </div>
  );
}

function NetworkDetailsPopover({ response }: { response: HttpResult }) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  const keepOpen = () => {
    clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const scheduleClose = () => {
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), 120);
  };
  let hostname = "Unknown";
  let secure = false;
  try {
    const url = new URL(response.url);
    hostname = url.hostname;
    secure = url.protocol === "https:";
  } catch {
    /* The validated request URL normally makes this unreachable. */
  }
  const rows = [
    ["HTTP version", response.httpVersion || "HTTP"],
    ["Local address", response.localAddress || "Not exposed"],
    ["Remote address", response.remoteAddress || "Not exposed"],
  ];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label="Network details"
          aria-expanded={open}
          className="size-control-xs text-content-tertiary"
          onMouseEnter={keepOpen}
          onMouseLeave={scheduleClose}
          onFocus={keepOpen}
          onBlur={scheduleClose}
          onClick={() => setOpen(!open)}
        >
          <Globe2 className="size-ui-3-5" aria-hidden="true" />
        </Button>
      </PopoverAnchor>
      <PopoverContent
        side="bottom"
        align="end"
        sideOffset={4}
        className="ui-validation-popover overflow-hidden rounded-ui-lg border border-border-default bg-purr-overlay p-ui-4 shadow-popover"
        onMouseEnter={keepOpen}
        onMouseLeave={scheduleClose}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div className="mb-ui-3 flex items-center gap-ui-2 text-ui-lg font-medium text-content-primary">
          <Globe2 className="size-ui-4 text-action-brand" aria-hidden="true" />
          Network
        </div>
        <dl className="m-ui-0 grid grid-cols-2 gap-x-ui-4 gap-y-ui-2 text-ui-sm">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-content-tertiary">{label}</dt>
              <dd className="m-ui-0 break-all font-code text-content-secondary">
                {value}
              </dd>
            </div>
          ))}
        </dl>
        <div className="my-ui-3 border-t border-border-subtle" />
        <dl className="m-ui-0 grid grid-cols-2 gap-x-ui-4 gap-y-ui-2 text-ui-sm">
          <dt className="text-content-tertiary">TLS validation</dt>
          <dd className="m-ui-0 font-code text-content-secondary">
            {secure ? "Enabled" : "Not applicable"}
          </dd>
          <dt className="text-content-tertiary">Server name</dt>
          <dd className="m-ui-0 break-all font-code text-content-secondary">
            {hostname}
          </dd>
        </dl>
        {secure ? (
          <p className="mb-ui-0 mt-ui-3 text-ui-xs text-content-quaternary">
            TLS protocol, cipher and certificate fields require lower-level
            transport instrumentation.
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

export function ResponseViewer({ response }: { response: HttpResult }) {
  const [tab, setTab] = useState<ResponseTab>("response");
  const cookieCount = useMemo(
    () => getResponseCookies(response.headers).length,
    [response.headers],
  );
  useEffect(() => setTab("response"), [response]);

  return (
    <section
      aria-label="HTTP response"
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-ui-xl bg-purr-surface shadow-panel"
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-ui-2 bg-purr-elevated p-ui-2">
        <div
          className="flex min-w-0 flex-wrap items-center gap-ui-1"
          role="tablist"
          aria-label="Response details"
        >
          {responseTabs.map((option) => {
            const Icon = option.icon;
            const count =
              option.value === "headers"
                ? response.headers.length
                : option.value === "cookie"
                  ? cookieCount
                  : null;
            return (
              <Button
                key={option.value}
                id={`response-tab-${option.value}`}
                type="button"
                role="tab"
                size="sm"
                variant="ghost"
                weight="normal"
                disabled={option.disabled}
                title={option.disabled ? "Coming soon" : undefined}
                aria-selected={tab === option.value}
                aria-controls="response-panel"
                className={cn(
                  tab === option.value
                    ? "bg-purr-highlight text-content-primary"
                    : "text-content-secondary",
                )}
                onClick={() => setTab(option.value)}
              >
                {Icon ? (
                  <Icon className="size-ui-3" aria-hidden="true" />
                ) : null}
                {option.label}
                {count !== null ? (
                  <span className="font-code text-ui-xs text-action-brand">
                    {count}
                  </span>
                ) : null}
              </Button>
            );
          })}
        </div>
        <div
          className="flex items-center gap-ui-2 font-code text-ui-xs text-content-tertiary"
          aria-label="Response summary"
        >
          <span className={cn("font-medium", statusClass(response.status))}>
            {response.status} {response.statusText}
          </span>
          <span>{response.httpVersion || "HTTP"}</span>
          <NetworkDetailsPopover response={response} />
          <span aria-hidden="true">•</span>
          <span>{response.durationMs} ms</span>
          <span aria-hidden="true">•</span>
          <span>{formatPayloadSize(response.size)}</span>
        </div>
      </div>
      <div
        id="response-panel"
        role="tabpanel"
        aria-labelledby={`response-tab-${tab}`}
        className="min-h-0 min-w-0 flex-1 overflow-hidden"
      >
        {tab === "response" ? <ResponseBodyPanel response={response} /> : null}
        {tab === "headers" ? (
          <ResponseHeadersPanel response={response} />
        ) : null}
        {tab === "cookie" ? (
          <ResponseCookiesPanel response={response} />
        ) : null}
        {tab === "timeline" ? (
          <ResponseTimelinePanel response={response} />
        ) : null}
      </div>
    </section>
  );
}
