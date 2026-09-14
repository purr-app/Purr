import {
  Check,
  Eye,
  EyeOff,
  GripVertical,
  LockKeyhole,
  Trash2,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type Ref,
} from "react";

import { cn } from "../../../shared/lib/cn";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "../../../shared/components/ui/popover";
import { FileUploader } from "../../../shared/components/ui/file-uploader";
import { SelectField } from "../../../shared/components/ui/select-field";
import { TemplateVariablePopover, type TemplateVariableActions } from "./template-variable-popover";

export type KeyValueEntry = {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
  readOnly?: boolean;
  readOnlyReason?: string;
  secret?: boolean;
  fieldType?: "text" | "file";
  attachment?: File | null;
  contentType?: string;
  badge?: string;
  scope?: string;
  hideReadOnlyIndicator?: boolean;
  keyReadOnly?: boolean;
  deletable?: boolean;
};

type KeyValueEditorProps = {
  entries: KeyValueEntry[];
  onEntriesChange: (entries: KeyValueEntry[]) => void;
  createEmptyEntry: (entries: KeyValueEntry[]) => KeyValueEntry;
  keyLabel: string;
  title?: string;
  keyPlaceholder: string;
  valuePlaceholder: string;
  keyTextClassName?: string;
  keySuggestions?: readonly string[];
  isKeyValid?: (key: string) => boolean;
  validationMessage?: string;
  valueFont?: "code" | "ui";
  className?: string;
  fillHeight?: boolean;
  multipart?: boolean;
  onReadOnlyEnabledChange?: (entry: KeyValueEntry, enabled: boolean) => void;
  scopeOptions?: readonly { value: string; label: string }[];
  scopeLabel?: (entry: KeyValueEntry) => string;
  variableActions?: TemplateVariableActions;
};

type KeyValueFieldProps = {
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
  validationMessage?: string;
  className?: string;
  readOnly?: boolean;
  label?: string;
  secret?: boolean;
  variableActions?: TemplateVariableActions;
};

function hasEntryContent(entry: KeyValueEntry) {
  return (
    entry.key.length > 0 || entry.value.length > 0 || Boolean(entry.attachment)
  );
}

function normalizeEntries(
  entries: KeyValueEntry[],
  createEmptyEntry: KeyValueEditorProps["createEmptyEntry"],
) {
  const populatedEntries = entries.filter(hasEntryContent);
  const emptyEntry =
    entries.find((entry) => !hasEntryContent(entry) && entry.enabled) ??
    entries.find((entry) => !hasEntryContent(entry));
  return emptyEntry
    ? [...populatedEntries, emptyEntry]
    : [...populatedEntries, createEmptyEntry(entries)];
}

function swapEntries(
  entries: KeyValueEntry[],
  sourceId: string,
  targetId: string,
  createEmptyEntry: KeyValueEditorProps["createEmptyEntry"],
) {
  const sourceIndex = entries.findIndex((entry) => entry.id === sourceId);
  const targetIndex = entries.findIndex((entry) => entry.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex)
    return entries;

  const nextEntries = [...entries];
  [nextEntries[sourceIndex], nextEntries[targetIndex]] = [
    nextEntries[targetIndex],
    nextEntries[sourceIndex],
  ];
  return normalizeEntries(nextEntries, createEmptyEntry);
}

function getEntryRowId(
  target: EventTarget | null,
  clientX: number,
  clientY: number,
) {
  const eventTarget = target instanceof Element ? target : null;
  const element = eventTarget ?? document.elementFromPoint(clientX, clientY);
  const row =
    element instanceof Element
      ? element.closest<HTMLElement>("[data-key-value-row-id]")
      : null;
  return row?.dataset.keyValueRowId ?? null;
}

export function KeyValueEditor({
  entries,
  onEntriesChange,
  createEmptyEntry,
  keyLabel,
  title,
  keyPlaceholder,
  valuePlaceholder,
  keyTextClassName = "text-action-brand",
  keySuggestions = [],
  isKeyValid = () => true,
  validationMessage,
  valueFont = "ui",
  className,
  fillHeight = true,
  multipart = false,
  onReadOnlyEnabledChange,
  scopeOptions,
  scopeLabel,
  variableActions,
}: KeyValueEditorProps) {
  const [draggedEntryId, setDraggedEntryId] = useState<string | null>(null);
  const [dropTargetEntryId, setDropTargetEntryId] = useState<string | null>(
    null,
  );
  const draggedEntryIdRef = useRef<string | null>(null);
  const entriesRef = useRef(entries);
  const keyInputRefs = useRef(new Map<string, HTMLInputElement>());

  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  const updateEntry = (entryId: string, update: Partial<KeyValueEntry>) => {
    const previousEntry = entries.find((entry) => entry.id === entryId);
    if (previousEntry?.readOnly || (previousEntry?.keyReadOnly && "key" in update)) {
      if (Object.keys(update).length === 1 && typeof update.enabled === "boolean")
        onReadOnlyEnabledChange?.(previousEntry, update.enabled);
      return;
    }
    const nextEntries = entries.map((entry) => {
      if (entry.id !== entryId) return entry;

      const nextEntry = { ...entry, ...update };
      const isNewEntry = !hasEntryContent(entry) && hasEntryContent(nextEntry);
      return isNewEntry ? { ...nextEntry, enabled: true } : nextEntry;
    });
    const nextEntry = nextEntries.find((entry) => entry.id === entryId);
    const wasCleared =
      ("key" in update || "value" in update) &&
      previousEntry &&
      nextEntry &&
      hasEntryContent(previousEntry) &&
      !hasEntryContent(nextEntry);
    onEntriesChange(
      normalizeEntries(
        wasCleared
          ? nextEntries.filter((entry) => entry.id !== entryId)
          : nextEntries,
        createEmptyEntry,
      ),
    );
  };

  const removeEntry = (entryId: string) =>
    onEntriesChange(
      normalizeEntries(
        entries.filter((entry) => entry.id !== entryId),
        createEmptyEntry,
      ),
    );

  const focusNextKey = (entryId: string) => {
    const index = entriesRef.current.findIndex((entry) => entry.id === entryId);
    const nextEntryId = entriesRef.current[index + 1]?.id;
    if (nextEntryId)
      requestAnimationFrame(() =>
        keyInputRefs.current.get(nextEntryId)?.focus(),
      );
  };

  const clearDrag = () => {
    draggedEntryIdRef.current = null;
    setDraggedEntryId(null);
    setDropTargetEntryId(null);
  };

  const startDrag = (entryId: string, event: DragEvent<HTMLDivElement>) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", entryId);
    const row = event.currentTarget.closest<HTMLElement>(
      "[data-key-value-row-id]",
    );
    if (row)
      event.dataTransfer.setDragImage(
        row,
        event.clientX - row.getBoundingClientRect().left,
        event.clientY - row.getBoundingClientRect().top,
      );

    draggedEntryIdRef.current = entryId;
    setDraggedEntryId(entryId);
    setDropTargetEntryId(null);
  };

  const markDropTarget = (
    targetId: string,
    event: DragEvent<HTMLDivElement>,
  ) => {
    const sourceId = draggedEntryIdRef.current;
    if (!sourceId || sourceId === targetId) return;

    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropTargetEntryId(targetId);
  };

  const dropOnRow = (targetId: string, event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const sourceId =
      event.dataTransfer.getData("text/plain") || draggedEntryIdRef.current;
    if (sourceId && sourceId !== targetId)
      onEntriesChange(
        swapEntries(entriesRef.current, sourceId, targetId, createEmptyEntry),
      );
    clearDrag();
  };

  useEffect(() => {
    if (!draggedEntryId) return;

    const updateDropTarget = (event: globalThis.DragEvent) => {
      const sourceId = draggedEntryIdRef.current;
      const targetId = getEntryRowId(
        event.target,
        event.clientX,
        event.clientY,
      );
      const target = entriesRef.current.find((entry) => entry.id === targetId);
      const isValidTarget = Boolean(
        sourceId &&
        target &&
        !target.readOnly &&
        target.id !== sourceId &&
        hasEntryContent(target),
      );

      if (isValidTarget) {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      }

      setDropTargetEntryId(isValidTarget ? targetId : null);
    };

    const handleDrop = (event: globalThis.DragEvent) => {
      const sourceId = draggedEntryIdRef.current;
      const targetId = getEntryRowId(
        event.target,
        event.clientX,
        event.clientY,
      );
      const target = entriesRef.current.find((entry) => entry.id === targetId);
      if (
        sourceId &&
        targetId &&
        sourceId !== targetId &&
        target &&
        !target.readOnly &&
        hasEntryContent(target)
      ) {
        event.preventDefault();
        onEntriesChange(
          swapEntries(entriesRef.current, sourceId, targetId, createEmptyEntry),
        );
      }
      clearDrag();
    };

    document.addEventListener("dragover", updateDropTarget);
    document.addEventListener("drop", handleDrop);
    return () => {
      document.removeEventListener("dragover", updateDropTarget);
      document.removeEventListener("drop", handleDrop);
    };
  }, [createEmptyEntry, draggedEntryId, onEntriesChange]);

  const attachFiles = (files: File[]) => {
    let next = [...entries];
    files.forEach((file) => {
      const empty =
        next.find((entry) => !hasEntryContent(entry)) ?? createEmptyEntry(next);
      next = [
        ...next.filter((entry) => entry.id !== empty.id),
        {
          ...empty,
          key: file.name,
          enabled: true,
          fieldType: "file",
          attachment: file,
          contentType: file.type || "application/octet-stream",
        },
      ];
    });
    onEntriesChange(normalizeEntries(next, createEmptyEntry));
  };

  return (
    <section
      className={cn(
        fillHeight && "min-h-full",
        "bg-purr-surface px-ui-3 py-ui-2",
        multipart && "ui-multipart-editor",
        className,
      )}
      aria-label={`${keyLabel} entries`}
      onDragOver={(event) => {
        if (multipart && event.dataTransfer.types.includes("Files"))
          event.preventDefault();
      }}
      onDrop={(event) => {
        if (multipart && event.dataTransfer.files.length) {
          event.preventDefault();
          attachFiles(Array.from(event.dataTransfer.files));
        }
      }}
    >
      {title ? (
        <p className="m-ui-0 mb-ui-1-5 font-ui text-ui-xs font-medium text-content-tertiary">
          {title}
        </p>
      ) : null}
      <div className="space-y-ui-2">
        {entries.map((entry) => (
          <KeyValueRow
            key={entry.id}
            entry={entry}
            multipart={multipart}
            keyLabel={keyLabel}
            keyTextClassName={keyTextClassName}
            keyPlaceholder={keyPlaceholder}
            valuePlaceholder={valuePlaceholder}
            keySuggestions={keySuggestions}
            isKeyValid={isKeyValid}
            validationMessage={validationMessage}
            valueFont={valueFont}
            isDragging={draggedEntryId === entry.id}
            isDropTarget={dropTargetEntryId === entry.id}
            onChange={(update) => updateEntry(entry.id, update)}
            onDelete={() => removeEntry(entry.id)}
            onValueCommit={() => focusNextKey(entry.id)}
            keyInputRef={(node) => {
              if (node) keyInputRefs.current.set(entry.id, node);
              else keyInputRefs.current.delete(entry.id);
            }}
            onDragStart={(event) => startDrag(entry.id, event)}
            onDragEnter={(event) => markDropTarget(entry.id, event)}
            onDragOver={(event) => markDropTarget(entry.id, event)}
            onDrop={(event) => dropOnRow(entry.id, event)}
            onDragEnd={clearDrag}
            canToggleReadOnly={Boolean(entry.readOnly && onReadOnlyEnabledChange)}
            scopeOptions={scopeOptions}
            scopeLabel={scopeLabel}
            variableActions={variableActions}
          />
        ))}
      </div>
    </section>
  );
}

type KeyValueRowProps = {
  entry: KeyValueEntry;
  multipart: boolean;
  keyLabel: string;
  keyTextClassName: string;
  keyPlaceholder: string;
  valuePlaceholder: string;
  keySuggestions: readonly string[];
  isKeyValid: (key: string) => boolean;
  validationMessage?: string;
  valueFont: "code" | "ui";
  isDragging: boolean;
  isDropTarget: boolean;
  onChange: (update: Partial<KeyValueEntry>) => void;
  onDelete: () => void;
  onValueCommit: () => void;
  keyInputRef: Ref<HTMLInputElement>;
  onDragStart: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnter: (event: DragEvent<HTMLDivElement>) => void;
  onDragOver: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
  canToggleReadOnly: boolean;
  scopeOptions?: readonly { value: string; label: string }[];
  scopeLabel?: (entry: KeyValueEntry) => string;
  variableActions?: TemplateVariableActions;
};

function KeyValueRow({
  entry,
  multipart,
  keyLabel,
  keyTextClassName,
  keyPlaceholder,
  valuePlaceholder,
  keySuggestions,
  isKeyValid,
  validationMessage,
  valueFont,
  isDragging,
  isDropTarget,
  onChange,
  onDelete,
  onValueCommit,
  keyInputRef,
  onDragStart,
  onDragEnter,
  onDragOver,
  onDragEnd,
  onDrop,
  canToggleReadOnly,
  scopeOptions,
  scopeLabel,
  variableActions,
}: KeyValueRowProps) {
  const valueInputRef = useRef<HTMLInputElement>(null);
  const hasContent = hasEntryContent(entry);

  return (
    <div
      data-key-value-row-id={entry.id}
      className={cn(
        "group flex min-w-0 items-center gap-ui-2 rounded-ui-md px-ui-1 transition-colors duration-ui-fast hover:bg-purr-surface",
        multipart && "ui-multipart-row",
        isDragging && "opacity-ui-inactive",
        isDropTarget && "ui-drop-indicator",
      )}
      onDragEnterCapture={(event) => {
        if (hasContent && !entry.readOnly) onDragEnter(event);
      }}
      onDragOverCapture={(event) => {
        if (hasContent && !entry.readOnly) onDragOver(event);
      }}
      onDropCapture={(event) => {
        if (hasContent && !entry.readOnly) onDrop(event);
      }}
    >
      <EntryCheckbox
        checked={entry.enabled}
        disabled={!hasContent || (Boolean(entry.readOnly) && !canToggleReadOnly)}
        onCheckedChange={(enabled) => onChange({ enabled })}
        label={entry.key ? `Include ${entry.key}` : `Include ${keyLabel}`}
      />
      {entry.badge ? (
        <span className="shrink-0 rounded-ui-sm bg-purr-highlight px-ui-1-5 py-ui-0-5 font-ui text-ui-2xs text-content-tertiary">
          {entry.badge}
        </span>
      ) : null}
      <EntryKeyField
        readOnly={entry.readOnly || entry.keyReadOnly}
        value={entry.key}
        muted={!entry.enabled}
        inputRef={keyInputRef}
        placeholder={keyPlaceholder}
        suggestions={keySuggestions}
        isValid={isKeyValid}
        validationMessage={validationMessage}
        textClassName={keyTextClassName}
        onChange={(key) => onChange({ key })}
        onSelect={(key) => onChange({ key, enabled: true })}
        onCommit={() => valueInputRef.current?.focus()}
      />
      {multipart ? (
        <SelectField
          className="w-full"
          label="Field type"
          muted={!entry.enabled}
          value={entry.fieldType || "text"}
          options={
            [
              { value: "text", label: "Text" },
              { value: "file", label: "File" },
            ] as const
          }
          onValueChange={(fieldType) =>
            onChange({
              fieldType,
              attachment: fieldType === "text" ? null : entry.attachment,
              contentType: "",
            })
          }
        />
      ) : null}
      {multipart && entry.fieldType === "file" ? (
        <FileUploader
          compact
          muted={!entry.enabled}
          file={entry.attachment ?? null}
          label={
            entry.key ? "Choose file for " + entry.key : "Choose field file"
          }
          onFileChange={(attachment) =>
            onChange({
              attachment,
              key: entry.key || attachment?.name || "",
              contentType: attachment?.type || "application/octet-stream",
            })
          }
        />
      ) : (
        <KeyValueField
          className="flex-1"
          readOnly={entry.readOnly}
          secret={entry.secret}
          label={entry.key ? "Value for " + entry.key : keyLabel + " value"}
          font={valueFont}
          inputRef={valueInputRef}
          muted={!entry.enabled}
          value={entry.value}
          placeholder={valuePlaceholder}
          onChange={(value) => onChange({ value })}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onValueCommit();
            }
          }}
          variableActions={variableActions}
        />
      )}
      {scopeOptions && entry.scope ? (
        <SelectField
          className="w-method-popover shrink-0"
          label={scopeLabel?.(entry) ?? `Scope for ${entry.key || keyLabel}`}
          value={entry.scope}
          options={scopeOptions}
          muted={!entry.enabled}
          onValueChange={(scope) => onChange({ scope })}
        />
      ) : null}
      {entry.readOnly && !entry.hideReadOnlyIndicator ? (
        <span
          className="flex size-control-xs items-center justify-center text-content-tertiary"
          title={entry.readOnlyReason}
          aria-label={entry.readOnlyReason}
        >
          <LockKeyhole className="size-ui-3" aria-hidden="true" />
        </span>
      ) : hasContent && !entry.readOnly && entry.deletable !== false ? (
        <DragHandle onDragStart={onDragStart} onDragEnd={onDragEnd} />
      ) : (
        <span className="size-control-xs shrink-0" aria-hidden="true" />
      )}
      {hasContent && !entry.readOnly && entry.deletable !== false ? (
        <button
          className="ui-focus-ring flex size-control-xs shrink-0 items-center justify-center rounded-ui-md text-content-tertiary opacity-ui-hidden transition-all duration-ui-fast hover:bg-purr-highlight hover:text-method-delete group-hover:opacity-ui-visible focus-visible:opacity-ui-visible"
          type="button"
          aria-label={entry.key ? `Delete ${entry.key}` : `Delete ${keyLabel}`}
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

function DragHandle({
  onDragStart,
  onDragEnd,
}: {
  onDragStart: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
}) {
  return (
    <div
      className="ui-focus-ring flex size-control-xs shrink-0 cursor-grab items-center justify-center rounded-ui-md text-content-tertiary opacity-ui-hidden transition-all duration-ui-fast hover:bg-purr-highlight hover:text-content-primary group-hover:opacity-ui-visible focus-visible:opacity-ui-visible active:cursor-grabbing"
      draggable
      role="button"
      tabIndex={0}
      aria-label="Reorder entry"
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <GripVertical className="size-ui-3-5" aria-hidden="true" />
    </div>
  );
}

function EntryCheckbox({
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
        checked
          ? "border-purr-muted bg-purr-muted text-content-primary"
          : "border-border-default bg-purr-surface text-transparent hover:bg-purr-highlight",
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

function EntryKeyField({
  value,
  muted,
  inputRef,
  placeholder,
  suggestions,
  isValid,
  validationMessage,
  textClassName,
  onChange,
  onSelect,
  onCommit,
  readOnly,
}: {
  value: string;
  muted: boolean;
  inputRef: Ref<HTMLInputElement>;
  placeholder: string;
  suggestions: readonly string[];
  isValid: (key: string) => boolean;
  validationMessage?: string;
  textClassName: string;
  onChange: (value: string) => void;
  onSelect: (value: string) => void;
  onCommit: () => void;
  readOnly?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(-1);
  const invalid = !isValid(value);
  const filteredSuggestions = useMemo(() => {
    const filter = value.trim().toLocaleLowerCase();
    return suggestions
      .filter((suggestion) => suggestion.toLocaleLowerCase().includes(filter))
      .slice(0, 8);
  }, [suggestions, value]);
  const showSuggestions =
    !readOnly &&
    isOpen &&
    !invalid &&
    value.trim().length > 0 &&
    filteredSuggestions.length > 0;
  const showValidation = Boolean(validationMessage && isFocused && invalid);
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
          <KeyValueField
            readOnly={readOnly}
            label={placeholder}
            className={cn("w-full", value && textClassName)}
            value={value}
            placeholder={placeholder}
            muted={muted}
            invalid={invalid}
            validationMessage={validationMessage}
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
                setActiveSuggestionIndex((index) =>
                  Math.min(index + 1, filteredSuggestions.length - 1),
                );
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
                const selectedSuggestion =
                  activeSuggestionIndex >= 0
                    ? filteredSuggestions[activeSuggestionIndex]
                    : undefined;
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
          className="ui-validation-popover z-50 rounded-ui-md border border-border-default bg-purr-overlay p-ui-2 shadow-popover"
          side="top"
          align="start"
          sideOffset={4}
          data-request-section-popover
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <p className="m-ui-0 font-ui text-ui-sm text-content-primary">
            {validationMessage}
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
          <div role="listbox" aria-label={`Common ${placeholder}s`}>
            {filteredSuggestions.map((suggestion, index) => (
              <button
                key={suggestion}
                className={cn(
                  "flex h-control-sm w-full items-center rounded-ui-sm px-ui-2 font-code text-ui-sm font-normal text-content-secondary transition-colors duration-ui-fast hover:bg-purr-highlight hover:text-content-primary",
                  activeSuggestionIndex === index &&
                    "bg-purr-highlight text-content-primary",
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

function KeyValueField({
  value,
  placeholder,
  onChange,
  onFocus,
  onBlur,
  onKeyDown,
  inputRef,
  font = "code",
  muted = false,
  invalid = false,
  validationMessage,
  className,
  readOnly,
  label,
  secret = false,
  variableActions,
}: KeyValueFieldProps) {
  const [revealed, setRevealed] = useState(false);
  if (secret)
    return (
      <div
        className={cn(
          "flex h-control-md min-w-0 items-center gap-ui-2 rounded-ui-md border border-transparent bg-purr-surface px-ui-2",
          className,
          muted && "opacity-ui-disabled",
          invalid && "border-method-delete",
        )}
      >
        <input
          className={cn(
            "h-full min-w-0 flex-1 bg-transparent px-ui-1 text-ui-md font-normal text-content-secondary outline-none disabled:cursor-not-allowed disabled:opacity-ui-visible",
            font === "code" ? "font-code" : "font-ui",
          )}
          type={revealed ? "text" : "password"}
          disabled={readOnly}
          aria-readonly={readOnly || undefined}
          aria-label={label}
          ref={inputRef}
          value={value}
          placeholder={placeholder}
          spellCheck="false"
          aria-invalid={invalid || undefined}
          title={invalid ? validationMessage : undefined}
          onChange={(event) => onChange(event.target.value)}
          onFocus={onFocus}
          onBlur={onBlur}
          onKeyDown={onKeyDown}
        />
        <button
          className="ui-focus-ring flex size-control-xs shrink-0 items-center justify-center rounded-ui-md text-content-tertiary hover:bg-purr-highlight hover:text-content-primary"
          type="button"
          aria-label={`${revealed ? "Hide" : "Reveal"} ${label ?? "secret"}`}
          aria-pressed={revealed}
          onClick={() => setRevealed(!revealed)}
        >
          {revealed ? (
            <EyeOff className="size-ui-3-5" aria-hidden="true" />
          ) : (
            <Eye className="size-ui-3-5" aria-hidden="true" />
          )}
        </button>
      </div>
    );

  const input = (bindings?: Parameters<Parameters<typeof TemplateVariablePopover>[0]["children"]>[0]) => <input
      className={cn(
        "h-control-md min-w-0 rounded-ui-md border border-transparent bg-transparent px-ui-2 text-ui-md font-normal text-content-primary outline-none transition-colors duration-ui-fast placeholder:text-content-tertiary focus:border-action-brand focus:bg-purr-surface disabled:cursor-not-allowed disabled:border-transparent disabled:bg-purr-surface disabled:text-content-secondary disabled:opacity-ui-visible",
        font === "code" ? "font-code" : "font-ui",
        className,
        muted && "text-content-tertiary placeholder:text-content-quaternary",
        invalid && "text-method-delete focus:border-method-delete",
      )}
      type="text"
      disabled={readOnly}
      aria-readonly={readOnly || undefined}
      aria-label={label}
      ref={bindings?.ref ?? inputRef}
      value={value}
      placeholder={placeholder}
      spellCheck="false"
      aria-invalid={invalid || undefined}
      title={invalid ? validationMessage : undefined}
      onChange={bindings?.onChange ?? ((event) => onChange(event.target.value))}
      onFocus={onFocus}
      onBlur={onBlur}
      onClick={bindings?.onClick}
      onKeyUp={bindings?.onKeyUp}
      onKeyDown={(event) => { bindings?.onKeyDown(event); if (!event.defaultPrevented) onKeyDown?.(event); }}
    />;
  return variableActions ? <TemplateVariablePopover value={value} onValueChange={onChange} actions={variableActions} inputRef={inputRef}>{(bindings) => input(bindings)}</TemplateVariablePopover> : input();
}
