import { Check, CircleOff, LockKeyhole, WandSparkles } from "lucide-react";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "../../../shared/components/ui/button";
import { FileUploader } from "../../../shared/components/ui/file-uploader";
import { cn } from "../../../shared/lib/cn";
import {
  bodyTypeOptions,
  createEmptyRequestBodyField,
  formatPayloadSize,
  getActiveBodyFields,
  getBodyContentType,
  getBodyDiagnostics,
  getRequestBodyValidationMessage,
  serializeRequestBody,
  switchRequestBodyType,
  type RequestBody,
  type RequestBodyField,
  type RequestBodyType,
} from "../model/request-body";
import { KeyValueEditor } from "./key-value-editor";
import { BodyCodeEditor, type BodyCodeEditorHandle } from "./body-code-editor";

type BodyEditorProps = {
  body: RequestBody;
  onBodyChange: (body: RequestBody) => void;
};
type ConversionNotice = {
  message: string;
  tone: "success" | "warning";
};
const createEmptyFormDataField = (fields: RequestBodyField[]) =>
  createEmptyRequestBodyField("form-data", fields);
const createEmptyUrlEncodedField = (fields: RequestBodyField[]) =>
  createEmptyRequestBodyField("url-encoded", fields);

export function BodyEditor({ body, onBodyChange }: BodyEditorProps) {
  const [conversionNotice, setConversionNotice] =
    useState<ConversionNotice | null>(null);
  const codeEditorRef = useRef<BodyCodeEditorHandle>(null);
  const tabRefs = useRef(new Map<RequestBodyType, HTMLButtonElement>());
  const isCode =
    body.type === "json" || body.type === "xml" || body.type === "text";
  const content = isCode ? body[body.type as "json" | "xml" | "text"] : "";
  const typeLabel = bodyTypeOptions.find(
    (option) => option.value === body.type,
  )!.label;
  const diagnostics = useMemo(
    () =>
      isCode
        ? getBodyDiagnostics(body.type as "json" | "xml" | "text", content)
        : [],
    [body.type, content, isCode],
  );
  const error = getRequestBodyValidationMessage(body);
  const bytes = useMemo(() => serializeRequestBody(body)?.size ?? 0, [body]);
  const contentType = getBodyContentType(body);
  const activeFields = getActiveBodyFields(body);
  const fileCount = activeFields.filter(
    (field) => field.fieldType === "file" && field.attachment,
  ).length;
  const empty =
    body.type === "none" ||
    (isCode
      ? !content.trim()
      : body.type === "binary"
        ? !body.binary
        : activeFields.length === 0);
  const status = error
    ? "Invalid " + typeLabel
    : empty
      ? body.type === "none"
        ? "No body"
        : "Empty body"
      : body.type === "json" || body.type === "xml"
        ? "Valid " + typeLabel
        : "Ready";

  const selectType = (type: RequestBodyType) => {
    const sourceLabel = typeLabel;
    const targetLabel = bodyTypeOptions.find(
      (option) => option.value === type,
    )!.label;
    const result = switchRequestBodyType(body, type);
    setConversionNotice(
      result.notice
        ? { message: result.notice, tone: "warning" }
        : result.conversion
          ? {
              message:
                result.conversion === "cleared"
                  ? `Synced empty ${sourceLabel} → ${targetLabel}.`
                  : `Converted ${sourceLabel} → ${targetLabel}.`,
              tone: "success",
            }
          : null,
    );
    onBodyChange(result.body);
  };
  const handleTabKey = (
    event: KeyboardEvent<HTMLButtonElement>,
    type: RequestBodyType,
  ) => {
    const current = bodyTypeOptions.findIndex(
      (option) => option.value === type,
    );
    let index = current;
    if (event.key === "ArrowRight")
      index = (current + 1) % bodyTypeOptions.length;
    else if (event.key === "ArrowLeft")
      index = (current + bodyTypeOptions.length - 1) % bodyTypeOptions.length;
    else if (event.key === "Home") index = 0;
    else if (event.key === "End") index = bodyTypeOptions.length - 1;
    else return;
    event.preventDefault();
    tabRefs.current.get(bodyTypeOptions[index].value)?.focus();
    selectType(bodyTypeOptions[index].value);
  };

  return (
    <section
      id="request-section-body"
      role="tabpanel"
      aria-labelledby="request-tab-body"
      className="min-w-0 overflow-hidden rounded-ui-xl bg-purr-surface"
      aria-label="Request body"
    >
      <div className="flex flex-wrap items-center justify-between gap-ui-2 bg-purr-elevated px-ui-3 py-ui-2">
        <div
          className="flex min-w-0 max-w-full overflow-x-auto rounded-ui-md bg-purr-surface p-ui-1 gap-ui-1"
          role="tablist"
          aria-label="Body format"
        >
          {bodyTypeOptions.map((option) => (
            <Button
              key={option.value}
              ref={(node) => {
                if (node) tabRefs.current.set(option.value, node);
                else tabRefs.current.delete(option.value);
              }}
              id={"body-format-" + option.value}
              role="tab"
              aria-selected={body.type === option.value}
              aria-controls="body-format-panel"
              tabIndex={body.type === option.value ? 0 : -1}
              type="button"
              variant="ghost"
              size="sm"
              weight="normal"
              className={cn(
                "gap-ui-1",
                body.type === option.value
                  ? "bg-purr-highlight text-action-brand"
                  : "text-content-tertiary",
              )}
              onClick={() => selectType(option.value)}
              onKeyDown={(event) => handleTabKey(event, option.value)}
            >
              {option.label}
              {body.type === option.value ? (
                <Check className="size-ui-3" aria-hidden="true" />
              ) : null}
            </Button>
          ))}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-ui-3">
          {body.type === "json" || body.type === "xml" ? (
            <button
              type="button"
              role="checkbox"
              aria-checked={body.autoConvert}
              title="When enabled, switching JSON/XML converts the current document and replaces the target draft. Disable it to keep separate drafts."
              className="ui-focus-ring flex h-control-sm items-center gap-ui-2 rounded-ui-md px-ui-1 font-ui text-ui-sm text-content-secondary hover:text-content-primary"
              onClick={() =>
                onBodyChange({ ...body, autoConvert: !body.autoConvert })
              }
            >
              <span
                className={cn(
                  "flex size-control-xs items-center justify-center rounded-ui-md border transition-colors duration-ui-fast",
                  body.autoConvert
                    ? "border-action-brand bg-action-brand text-content-primary"
                    : "border-border-default bg-purr-surface text-transparent",
                )}
              >
                <Check className="size-ui-3-5" aria-hidden="true" />
              </span>
              Auto-convert JSON ↔ XML
            </button>
          ) : null}
          {body.type === "json" || body.type === "xml" ? (
            <Button
              type="button"
              size="sm"
              weight="normal"
              variant="ghost"
              className="bg-purr-highlight"
              disabled={!content.trim() || Boolean(error)}
              onClick={() => codeEditorRef.current?.prettify()}
            >
              <WandSparkles className="size-ui-3-5" />
              Format {body.type.toUpperCase()}
            </Button>
          ) : null}
          {contentType ? (
            <span
              title={contentType + " · set automatically in Headers"}
              className="flex min-w-0 items-center gap-ui-1-5 rounded-ui-sm bg-action-brand-surface px-ui-2 py-ui-1 font-code text-ui-xs text-syntax-tag"
            >
              <LockKeyhole className="size-ui-3 shrink-0" />
              <span className="truncate">{contentType.split(";")[0]}</span>
            </span>
          ) : null}
        </div>
      </div>

      <div
        id="body-format-panel"
        role="tabpanel"
        aria-labelledby={"body-format-" + body.type}
        className="min-w-0"
      >
        {body.type === "json" || body.type === "xml" || body.type === "text" ? (
          <BodyCodeEditor
            key={body.type}
            ref={codeEditorRef}
            language={body.type}
            value={body[body.type]}
            onChange={(value) => {
              setConversionNotice(null);
              onBodyChange({ ...body, [body.type]: value });
            }}
          />
        ) : body.type === "form-data" ? (
          <KeyValueEditor
            multipart
            entries={body.formData}
            onEntriesChange={(formData) => onBodyChange({ ...body, formData })}
            createEmptyEntry={createEmptyFormDataField}
            keyLabel="form-data field"
            keyPlaceholder="name"
            valuePlaceholder="value"
            keyTextClassName="text-syntax-property"
            valueFont="ui"
            className="bg-purr-surface px-ui-3 py-ui-3"
          />
        ) : body.type === "url-encoded" ? (
          <KeyValueEditor
            entries={body.urlEncoded}
            onEntriesChange={(urlEncoded) =>
              onBodyChange({ ...body, urlEncoded })
            }
            createEmptyEntry={createEmptyUrlEncodedField}
            keyLabel="URL encoded field"
            title="URL encoded fields"
            keyPlaceholder="name"
            valuePlaceholder="value"
            keyTextClassName="text-syntax-property"
            valueFont="ui"
            className="bg-purr-surface px-ui-3 py-ui-3"
          />
        ) : body.type === "binary" ? (
          <FileUploader
            dense
            file={body.binary?.file ?? null}
            onFileChange={(file) =>
              onBodyChange({
                ...body,
                binary: file
                  ? {
                      file,
                      name: file.name,
                      size: file.size,
                      mimeType: file.type || "application/octet-stream",
                    }
                  : null,
              })
            }
          />
        ) : (
          <div className="flex items-center gap-ui-2 bg-purr-surface px-ui-4 py-ui-3 text-content-tertiary">
            <CircleOff className="size-ui-4" aria-hidden="true" />
            <span className="font-ui text-ui-sm">No body</span>
          </div>
        )}
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-x-ui-4 gap-y-ui-1 bg-purr-elevated px-ui-3 py-ui-1-5 font-code text-ui-xs text-content-tertiary">
        <div
          className="flex min-w-0 flex-1 flex-wrap items-center gap-x-ui-3 gap-y-ui-1"
          role="status"
          aria-live="polite"
        >
          <button
            type="button"
            onClick={() => codeEditorRef.current?.focusError()}
            disabled={!diagnostics.length}
            className={cn(
              "ui-focus-ring inline-flex shrink-0 items-center gap-ui-1-5 rounded-ui-sm disabled:cursor-default",
              error ? "text-accent-red" : !empty && "text-syntax-string",
            )}
          >
            <span
              className={cn(
                "size-ui-1-5 rounded-full",
                error
                  ? "bg-accent-red"
                  : empty
                    ? "bg-content-quaternary"
                    : "bg-syntax-string",
              )}
            />
            {status}
          </button>
          {error ? (
            <span className="min-w-0 text-accent-red">
              {diagnostics[0]
                ? "Ln " +
                  diagnostics[0].line +
                  ", Col " +
                  diagnostics[0].column +
                  " · "
                : ""}
              {error}
            </span>
          ) : (
            <span>
              {isCode
                ? typeLabel + " · UTF-8"
                : body.type === "form-data"
                  ? activeFields.length + " fields · " + fileCount + " files"
                  : body.type === "binary"
                    ? body.binary?.mimeType
                    : null}
            </span>
          )}
        </div>
        <div className="ml-auto flex min-w-0 max-w-full shrink items-center justify-end gap-ui-3">
          {isCode ? <span>Lines: {content.split("\n").length}</span> : null}
          {conversionNotice ? (
            <span
              className={cn(
                "min-w-0 truncate font-ui",
                conversionNotice.tone === "success"
                  ? "text-syntax-string"
                  : "text-accent-orange",
              )}
              title={conversionNotice.message}
            >
              {conversionNotice.message}
            </span>
          ) : null}
          <span>Size: {formatPayloadSize(bytes)}</span>
        </div>
      </footer>
    </section>
  );
}
