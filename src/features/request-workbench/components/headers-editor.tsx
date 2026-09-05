import { Check, GripVertical, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type Ref } from "react";

import { commonHttpHeaders } from "../../../shared/config/http-headers";
import { cn } from "../../../shared/lib/cn";
import { Popover, PopoverAnchor, PopoverContent } from "../../../shared/components/ui/popover";
import { isRequestHeaderNameValid, type RequestHeader } from "../model/request";

type HeadersEditorProps = {
  headers: RequestHeader[];
  onHeadersChange: (headers: RequestHeader[]) => void;
};

type HeaderFieldProps = {
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  inputRef?: Ref<HTMLInputElement>;
  font?: "code" | "ui";
  muted?: boolean;
  invalid?: boolean;
  className?: string;
};

function createEmptyHeader(headers: RequestHeader[] = []): RequestHeader {
  const highestId = headers.reduce((highest, header) => {
    const number = Number(header.id.replace("header-", ""));
    return Number.isFinite(number) ? Math.max(highest, number) : highest;
  }, 0);

  return {
    id: `header-${highestId + 1}`,
    name: "",
    value: "",
    enabled: false,
  };
}

function hasHeaderContent(header: RequestHeader) {
  return header.name.length > 0 || header.value.length > 0;
}

function normalizeHeaders(headers: RequestHeader[]) {
  const populatedHeaders = headers.filter(hasHeaderContent);
  const emptyHeader = headers.find((header) => !hasHeaderContent(header) && header.enabled) ?? headers.find((header) => !hasHeaderContent(header));
  return emptyHeader ? [...populatedHeaders, emptyHeader] : [...populatedHeaders, createEmptyHeader(headers)];
}

function swapHeaderOrder(headers: RequestHeader[], sourceId: string, targetId: string) {
  const sourceIndex = headers.findIndex((header) => header.id === sourceId);
  const targetIndex = headers.findIndex((header) => header.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return headers;

  const nextHeaders = [...headers];
  [nextHeaders[sourceIndex], nextHeaders[targetIndex]] = [nextHeaders[targetIndex], nextHeaders[sourceIndex]];
  return normalizeHeaders(nextHeaders);
}

function getHeaderRowId(target: EventTarget | null, clientX: number, clientY: number) {
  const eventTarget = target instanceof Element ? target : null;
  const element = eventTarget ?? document.elementFromPoint(clientX, clientY);
  const row = element instanceof Element ? element.closest<HTMLElement>("[data-header-row-id]") : null;
  return row?.dataset.headerRowId ?? null;
}

export function HeadersEditor({ headers, onHeadersChange }: HeadersEditorProps) {
  const [draggedHeaderId, setDraggedHeaderId] = useState<string | null>(null);
  const [dropTargetHeaderId, setDropTargetHeaderId] = useState<string | null>(null);
  const draggedHeaderIdRef = useRef<string | null>(null);
  const headersRef = useRef(headers);
  const nameInputRefs = useRef(new Map<string, HTMLInputElement>());

  useEffect(() => {
    headersRef.current = headers;
  }, [headers]);

  const updateHeader = (headerId: string, update: Partial<RequestHeader>) => {
    const previousHeader = headers.find((header) => header.id === headerId);
    const nextHeaders = headers.map((header) => {
      if (header.id !== headerId) return header;

      const nextHeader = { ...header, ...update };
      const isNewHeader = ("name" in update || "value" in update) && !hasHeaderContent(header) && hasHeaderContent(nextHeader);
      return isNewHeader ? { ...nextHeader, enabled: true } : nextHeader;
    });
    const nextHeader = nextHeaders.find((header) => header.id === headerId);
    const editedFieldWasCleared = ("name" in update || "value" in update) && previousHeader && nextHeader && hasHeaderContent(previousHeader) && !hasHeaderContent(nextHeader);
    onHeadersChange(normalizeHeaders(editedFieldWasCleared ? nextHeaders.filter((header) => header.id !== headerId) : nextHeaders));
  };

  const removeHeader = (headerId: string) => {
    onHeadersChange(normalizeHeaders(headers.filter((header) => header.id !== headerId)));
  };

  const focusNextHeaderName = (headerId: string) => {
    const index = headersRef.current.findIndex((header) => header.id === headerId);
    const nextHeaderId = headersRef.current[index + 1]?.id;
    if (!nextHeaderId) return;

    requestAnimationFrame(() => nameInputRefs.current.get(nextHeaderId)?.focus());
  };

  const startDrag = (headerId: string, event: DragEvent<HTMLDivElement>) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", headerId);

    const row = event.currentTarget.closest<HTMLElement>("[data-header-row-id]");
    if (row) event.dataTransfer.setDragImage(row, event.clientX - row.getBoundingClientRect().left, event.clientY - row.getBoundingClientRect().top);

    draggedHeaderIdRef.current = headerId;
    setDraggedHeaderId(headerId);
    setDropTargetHeaderId(null);
  };

  const clearDrag = () => {
    draggedHeaderIdRef.current = null;
    setDraggedHeaderId(null);
    setDropTargetHeaderId(null);
  };

  const markDropTarget = (targetId: string, event: DragEvent<HTMLDivElement>) => {
    const sourceId = draggedHeaderIdRef.current;
    if (!sourceId || sourceId === targetId) return;

    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropTargetHeaderId(targetId);
  };

  const dropOnRow = (targetId: string, event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const sourceId = event.dataTransfer.getData("text/plain") || draggedHeaderIdRef.current;
    if (sourceId && sourceId !== targetId) onHeadersChange(swapHeaderOrder(headersRef.current, sourceId, targetId));
    clearDrag();
  };

  useEffect(() => {
    if (!draggedHeaderId) return;

    const updateDropTarget = (event: globalThis.DragEvent) => {
      const sourceId = draggedHeaderIdRef.current;
      const targetId = getHeaderRowId(event.target, event.clientX, event.clientY);
      const target = headersRef.current.find((header) => header.id === targetId);
      const isValidTarget = Boolean(sourceId && target && target.id !== sourceId && (target.name.trim() || target.value.trim()));

      if (isValidTarget) {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      }

      setDropTargetHeaderId(isValidTarget ? targetId : null);
    };

    const handleDrop = (event: globalThis.DragEvent) => {
      const sourceId = draggedHeaderIdRef.current;
      const targetId = getHeaderRowId(event.target, event.clientX, event.clientY);
      const target = headersRef.current.find((header) => header.id === targetId);

      if (sourceId && targetId && sourceId !== targetId && target && (target.name.trim() || target.value.trim())) {
        event.preventDefault();
        onHeadersChange(swapHeaderOrder(headersRef.current, sourceId, targetId));
      }

      clearDrag();
    };

    document.addEventListener("dragover", updateDropTarget);
    document.addEventListener("drop", handleDrop);
    return () => {
      document.removeEventListener("dragover", updateDropTarget);
      document.removeEventListener("drop", handleDrop);
    };
  }, [draggedHeaderId, onHeadersChange]);

  return (
    <section className="bg-purr-elevated px-ui-3 py-ui-2" aria-label="Request headers">
      <div className="space-y-ui-2">
        {headers.map((header) => (
          <HeaderRow
            key={header.id}
            header={header}
            isDragging={draggedHeaderId === header.id}
            isDropTarget={dropTargetHeaderId === header.id}
            onChange={(update) => updateHeader(header.id, update)}
            onDelete={() => removeHeader(header.id)}
            onValueCommit={() => focusNextHeaderName(header.id)}
            nameInputRef={(node) => {
              if (node) nameInputRefs.current.set(header.id, node);
              else nameInputRefs.current.delete(header.id);
            }}
            onDragStart={(event) => startDrag(header.id, event)}
            onDragEnter={(event) => markDropTarget(header.id, event)}
            onDragOver={(event) => markDropTarget(header.id, event)}
            onDrop={(event) => dropOnRow(header.id, event)}
            onDragEnd={clearDrag}
          />
        ))}
      </div>
    </section>
  );
}

type HeaderRowProps = {
  header: RequestHeader;
  isDragging: boolean;
  isDropTarget: boolean;
  onChange: (update: Partial<RequestHeader>) => void;
  onDelete: () => void;
  onValueCommit: () => void;
  nameInputRef: Ref<HTMLInputElement>;
  onDragStart: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnter: (event: DragEvent<HTMLDivElement>) => void;
  onDragOver: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
};

function HeaderRow({ header, isDragging, isDropTarget, onChange, onDelete, onValueCommit, nameInputRef, onDragStart, onDragEnter, onDragOver, onDragEnd, onDrop }: HeaderRowProps) {
  const valueInputRef = useRef<HTMLInputElement>(null);
  const hasContent = hasHeaderContent(header);

  const handleNameCommit = () => valueInputRef.current?.focus();
  const handleValueCommit = () => onValueCommit();

  return (
    <div
      data-header-row-id={header.id}
      className={cn(
        "group flex min-w-0 items-center gap-ui-2 rounded-ui-md px-ui-2 transition-colors duration-ui-fast hover:bg-purr-surface",
        isDragging && "opacity-ui-inactive",
        isDropTarget && "ui-drop-indicator",
      )}
      onDragEnterCapture={(event) => {
        if (hasContent) onDragEnter(event);
      }}
      onDragOverCapture={(event) => {
        if (hasContent) onDragOver(event);
      }}
      onDropCapture={(event) => {
        if (hasContent) onDrop(event);
      }}
    >
      <HeaderEnabledCheckbox
        checked={header.enabled}
        disabled={!hasContent}
        onCheckedChange={(enabled) => onChange({ enabled })}
        label={header.name ? `Include ${header.name} header` : "Include header"}
      />
      <HeaderNameField
        value={header.name}
        muted={!header.enabled}
        inputRef={nameInputRef}
        onChange={(name) => onChange({ name })}
        onSelect={(name) => onChange({ name, enabled: true })}
        onCommit={handleNameCommit}
      />
      <HeaderField
        className="flex-1"
        font="ui"
        inputRef={valueInputRef}
        muted={!header.enabled}
        value={header.value}
        placeholder="value"
        onChange={(value) => onChange({ value })}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            handleValueCommit();
          }
        }}
      />
      {hasContent ? <HeaderDragHandle onDragStart={onDragStart} onDragEnd={onDragEnd} /> : <span className="size-control-xs shrink-0" aria-hidden="true" />}
      {hasContent ? (
        <button
          className="ui-focus-ring flex size-control-xs shrink-0 items-center justify-center rounded-ui-md text-content-tertiary opacity-ui-hidden transition-all duration-ui-fast hover:bg-purr-highlight hover:text-method-delete group-hover:opacity-ui-visible focus-visible:opacity-ui-visible"
          type="button"
          aria-label={header.name ? `Delete ${header.name} header` : "Delete header"}
          onClick={onDelete}
        >
          <Trash2 className="size-ui-3-5" aria-hidden="true" />
        </button>
      ) : (
        <span className="size-control-xs shrink-0" aria-hidden="true" />
      )}
    </div>
  );
}

function HeaderDragHandle({ onDragStart, onDragEnd }: {
  onDragStart: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
}) {
  return (
    <div
      className="ui-focus-ring flex size-control-xs shrink-0 cursor-grab items-center justify-center rounded-ui-md text-content-tertiary opacity-ui-hidden transition-all duration-ui-fast hover:bg-purr-highlight hover:text-content-primary group-hover:opacity-ui-visible focus-visible:opacity-ui-visible active:cursor-grabbing"
      draggable
      role="button"
      tabIndex={0}
      aria-label="Reorder header"
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <GripVertical className="size-ui-3-5" aria-hidden="true" />
    </div>
  );
}

function HeaderEnabledCheckbox({
  checked,
  disabled,
  onCheckedChange,
  label,
}: {
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <button
      className={cn(
        "ui-focus-ring flex size-control-xs shrink-0 items-center justify-center rounded-ui-md border transition-colors duration-ui-fast disabled:cursor-not-allowed disabled:opacity-ui-inactive",
        checked ? "border-purr-muted bg-purr-muted text-content-primary" : "border-border-default bg-purr-surface text-transparent hover:bg-purr-highlight",
      )}
      type="button"
      disabled={disabled}
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onCheckedChange(!checked)}
    >
      <Check className="size-ui-3-5" aria-hidden="true" />
    </button>
  );
}

function HeaderNameField({
  value,
  muted,
  inputRef,
  onChange,
  onSelect,
  onCommit,
}: {
  value: string;
  muted: boolean;
  inputRef: Ref<HTMLInputElement>;
  onChange: (value: string) => void;
  onSelect: (value: string) => void;
  onCommit: () => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(-1);
  const isInvalid = !isRequestHeaderNameValid(value);
  const suggestions = useMemo(() => {
    const filter = value.trim().toLocaleLowerCase();
    return commonHttpHeaders.filter((header) => header.toLocaleLowerCase().includes(filter)).slice(0, 8);
  }, [value]);
  const showSuggestions = isOpen && !isInvalid && value.trim().length > 0 && suggestions.length > 0;
  const showValidation = isFocused && isInvalid;
  const popoverIsOpen = showSuggestions || showValidation;

  const selectSuggestion = (suggestion: string) => {
    onSelect(suggestion);
    setActiveSuggestionIndex(-1);
    setIsOpen(false);
  };

  return (
    <Popover open={popoverIsOpen} onOpenChange={setIsOpen}>
      <PopoverAnchor asChild>
        <div className="min-w-0 flex-1">
          <HeaderField
            className={cn("w-full", value && "text-action-brand")}
            value={value}
            placeholder="name"
            muted={muted}
            invalid={isInvalid}
            inputRef={inputRef}
            onChange={(nextValue) => {
              onChange(nextValue);
              setIsOpen(true);
              setActiveSuggestionIndex(-1);
            }}
            onFocus={() => {
              setIsFocused(true);
              setIsOpen(value.trim().length > 0);
            }}
            onBlur={() => setIsFocused(false)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" && showSuggestions) {
                event.preventDefault();
                setActiveSuggestionIndex((index) => Math.min(index + 1, suggestions.length - 1));
                return;
              }

              if (event.key === "ArrowUp" && showSuggestions) {
                event.preventDefault();
                setActiveSuggestionIndex((index) => Math.max(index - 1, 0));
                return;
              }

              if (event.key === "Escape") {
                setIsOpen(false);
                setActiveSuggestionIndex(-1);
                return;
              }

              if (event.key === "Enter") {
                event.preventDefault();
                const selectedSuggestion = activeSuggestionIndex >= 0 ? suggestions[activeSuggestionIndex] : undefined;
                if (selectedSuggestion) {
                  selectSuggestion(selectedSuggestion);
                  return;
                }
                setIsOpen(false);
                onCommit();
              }
            }}
          />
        </div>
      </PopoverAnchor>
      {showValidation ? (
        <PopoverContent
          className="ui-header-validation-popover z-50 rounded-ui-md border border-border-default bg-purr-overlay p-ui-2 shadow-popover"
          side="top"
          align="start"
          sideOffset={4}
          data-request-section-popover
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <p className="m-ui-0 font-ui text-ui-sm text-content-primary">
            Header names may only use Latin letters, digits, and valid HTTP token symbols — without spaces.
          </p>
        </PopoverContent>
      ) : showSuggestions ? (
        <PopoverContent
          className="ui-popover-match-anchor z-50 overflow-hidden rounded-ui-md border border-border-default bg-purr-overlay p-ui-1 shadow-popover"
          side="bottom"
          align="start"
          sideOffset={4}
          data-request-section-popover
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <div role="listbox" aria-label="Common HTTP headers">
            {suggestions.map((suggestion, index) => (
              <button
                key={suggestion}
                className={cn(
                  "flex h-control-sm w-full items-center rounded-ui-sm px-ui-2 font-code text-ui-sm font-normal text-content-secondary transition-colors duration-ui-fast hover:bg-purr-highlight hover:text-content-primary",
                  activeSuggestionIndex === index && "bg-purr-highlight text-content-primary",
                )}
                type="button"
                role="option"
                aria-selected={activeSuggestionIndex === index}
                onMouseDown={(event) => {
                  event.preventDefault();
                  selectSuggestion(suggestion);
                }}
              >
                {suggestion}
              </button>
            ))}
          </div>
        </PopoverContent>
      ) : null}
    </Popover>
  );
}

function HeaderField({ value, placeholder, onChange, onFocus, onBlur, onKeyDown, inputRef, font = "code", muted = false, invalid = false, className }: HeaderFieldProps) {
  return (
    <input
      className={cn(
        "h-control-md min-w-0 rounded-ui-md border border-transparent bg-transparent px-ui-2 text-ui-md font-normal text-content-primary outline-none transition-colors duration-ui-fast placeholder:text-content-tertiary focus:border-action-brand focus:bg-purr-surface",
        font === "code" ? "font-code" : "font-ui",
        className,
        muted && "text-content-tertiary placeholder:text-content-quaternary opacity-ui-inactive",
        invalid && "text-method-delete focus:border-method-delete",
      )}
      type="text"
      ref={inputRef}
      value={value}
      placeholder={placeholder}
      spellCheck="false"
      aria-invalid={invalid || undefined}
      title={invalid ? "Header names may only use Latin letters, digits, and valid HTTP token symbols without spaces." : undefined}
      onChange={(event) => onChange(event.target.value)}
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
    />
  );
}
