import { useState } from "react";
import { cn } from "../../../shared/lib/cn";
import { Button } from "../../../shared/components/ui/button";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "../../../shared/components/ui/popover";
import {
  requestEditorSections,
  graphqlEditorSections,
  type RequestEditorSection,
} from "../model/request-editor-section";
import { bodyTypeOptions, type RequestBodyType } from "../model/request-body";
import { authTypeOptions, type AuthType } from "../model/request-auth";
import { ChevronDown, Code2 } from "lucide-react";

type RequestSectionTabsProps = {
  graphql?: boolean;
  activeSection: RequestEditorSection;
  onSectionChange: (section: RequestEditorSection) => void;
  bodyType: RequestBodyType;
  authType: AuthType;
  queryCount: number;
  headerCount: number;
  hasHeaderError: boolean;
  onOpenCode: () => void;
  detailsCollapsed?: boolean;
  onToggleDetails?: () => void;
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
  graphql = false,
  onOpenCode,
  detailsCollapsed = false,
  onToggleDetails,
}: RequestSectionTabsProps) {
  return (
    <div
      className="flex h-request-options shrink-0 items-center justify-between gap-ui-2 border-b border-border-subtle bg-purr-elevated px-ui-2 py-ui-1-5"
      data-request-options-bar
    >
      <div
        className="flex min-w-0 items-center gap-ui-1 overflow-x-auto"
        role="tablist"
        aria-label="Request options"
      >
        {(graphql ? graphqlEditorSections : requestEditorSections).map((section) => {
            const selected = !detailsCollapsed && activeSection === section.id;
            return (
              <Button
                key={section.id}
                id={`request-tab-${section.id}`}
                className={cn(
                  selected
                    ? "bg-purr-highlight text-content-primary"
                    : "text-content-secondary opacity-ui-inactive",
                )}
                variant="ghost"
                weight="normal"
                type="button"
                role="tab"
                aria-selected={selected}
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
      <div className="flex shrink-0 items-center gap-ui-1">
        <Button type="button" variant="ghost" size="icon" className="shrink-0 text-content-tertiary" aria-label="Open request code" title="Request code" onClick={onOpenCode}>
          <Code2 className="size-ui-4" aria-hidden="true" />
        </Button>
        {onToggleDetails ? <Button type="button" size="icon" variant="ghost" aria-label={detailsCollapsed ? "Expand request details" : "Collapse request details"} aria-expanded={!detailsCollapsed} aria-controls="request-details" onClick={onToggleDetails}>
          <ChevronDown className={cn("size-ui-4 transition-transform duration-ui-layout motion-reduce:transition-none", !detailsCollapsed && "rotate-180")} aria-hidden="true" />
        </Button> : null}
      </div>
    </div>
  );
}
