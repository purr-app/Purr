import { Cookie as CookieIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "../../../shared/lib/cn";
import { Button } from "../../../shared/components/ui/button";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "../../../shared/components/ui/popover";
import {
  requestEditorSections,
  type RequestEditorSection,
} from "../model/request-editor-section";
import { bodyTypeOptions, type RequestBodyType } from "../model/request-body";
import { authTypeOptions, type AuthType } from "../model/request-auth";

type RequestSectionTabsProps = {
  activeSection: RequestEditorSection;
  onSectionChange: (section: RequestEditorSection) => void;
  bodyType: RequestBodyType;
  authType: AuthType;
  queryCount: number;
  headerCount: number;
  hasHeaderError: boolean;
  trailing?: ReactNode;
};

function BodyTypeIndicator({ bodyType }: { bodyType: RequestBodyType }) {
  const [open, setOpen] = useState(false);
  const label = bodyTypeOptions.find(
    (option) => option.value === bodyType,
  )?.label;
  if (bodyType === "none" || !label) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <span
          className="size-ui-2 rounded-full bg-action-brand"
          aria-label={`Body format: ${label}`}
          title={`Body format: ${label}`}
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
        />
      </PopoverAnchor>
      <PopoverContent
        side="top"
        sideOffset={4}
        className="rounded-ui-md border border-border-default bg-purr-overlay px-ui-2 py-ui-1 font-ui text-ui-xs text-content-secondary shadow-popover"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        {label}
      </PopoverContent>
    </Popover>
  );
}

export function RequestSectionTabs({
  activeSection,
  onSectionChange,
  bodyType,
  authType,
  queryCount,
  headerCount,
  hasHeaderError,
  trailing,
}: RequestSectionTabsProps) {
  return (
    <div
      className="flex min-h-control-md shrink-0 items-center justify-between gap-ui-2 border-b border-border-subtle bg-purr-elevated px-ui-2 py-ui-1-5"
    >
      <div
        className="flex min-w-0 items-center gap-ui-1 overflow-x-auto"
        role="tablist"
        aria-label="Request options"
      >
        {requestEditorSections
          .filter((section) => section.id !== "cookies")
          .map((section) => {
            return (
              <Button
                key={section.id}
                id={`request-tab-${section.id}`}
                className={cn(
                  activeSection === section.id
                    ? "bg-purr-highlight text-content-primary"
                    : "text-content-secondary opacity-ui-inactive",
                )}
                variant="ghost"
                weight="normal"
                type="button"
                role="tab"
                aria-selected={activeSection === section.id}
                aria-controls={`request-section-${section.id}`}
                onClick={() => onSectionChange(section.id)}
              >
                {section.label}
                {section.id === "body" ? (
                  <BodyTypeIndicator bodyType={bodyType} />
                ) : null}
                {section.id === "query" && queryCount > 0 ? (
                  <span className="font-code text-action-brand">
                    {queryCount}
                  </span>
                ) : null}
                {section.id === "auth" && authType !== "none" ? (
                  <span
                    className="size-ui-2 rounded-full bg-action-brand"
                    title={
                      authTypeOptions.find(
                        (option) => option.value === authType,
                      )?.label
                    }
                    aria-label={`Auth: ${authType}`}
                  />
                ) : null}
                {section.id === "headers" && hasHeaderError ? (
                  <span
                    className="size-ui-2 rounded-full bg-method-delete"
                    aria-label="Headers contain validation errors"
                  />
                ) : null}
                {section.id === "headers" &&
                !hasHeaderError &&
                headerCount > 0 ? (
                  <span className="font-code text-action-brand">
                    {headerCount}
                  </span>
                ) : null}
              </Button>
            );
          })}
      </div>
      {trailing}
    </div>
  );
}

export function RequestCookiesButton({
  active,
  cookieCount,
  useCookieJar,
  onClick,
}: {
  active: boolean;
  cookieCount: number;
  useCookieJar: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      id="request-cookies-button"
      className={cn(
        active
          ? "bg-purr-highlight text-content-primary"
          : "text-content-secondary opacity-ui-inactive",
      )}
      variant="ghost"
      weight="normal"
      type="button"
      aria-pressed={active}
      aria-controls="request-section-cookies"
      onClick={onClick}
    >
      <CookieIcon className="size-ui-3-5 text-action-brand" aria-hidden="true" />
      Cookies
      <span className="font-code text-action-brand">
        {useCookieJar ? cookieCount : "Off"}
      </span>
    </Button>
  );
}
