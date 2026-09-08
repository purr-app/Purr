import { FileUp, Paperclip, X } from "lucide-react";
import { useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { Button } from "./button";

type FileUploaderProps = {
  file: File | null;
  onFileChange: (file: File | null) => void;
  compact?: boolean;
  dense?: boolean;
  label?: string;
  muted?: boolean;
};

export function FileUploader({
  file,
  onFileChange,
  compact = false,
  dense = false,
  label = "Choose body file",
  muted = false,
}: FileUploaderProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  return (
    <div
      className={cn(
        "min-w-0 rounded-ui-md transition-colors duration-ui-fast",
        compact
          ? "flex items-center bg-purr-elevated"
          : cn(
              "flex flex-col items-center justify-center bg-purr-surface",
              dense ? "gap-ui-2 p-ui-3" : "min-h-panel gap-ui-3 p-ui-6",
            ),
        dragActive && "bg-action-brand-surface",
        muted && "opacity-ui-inactive",
      )}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          event.stopPropagation();
          setDragActive(true);
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setDragActive(false);
      }}
      onDrop={(event) => {
        if (event.dataTransfer.files.length) {
          event.preventDefault();
          event.stopPropagation();
          setDragActive(false);
          onFileChange(event.dataTransfer.files[0]);
        }
      }}
    >
      <input
        ref={inputRef}
        type="file"
        tabIndex={-1}
        className="sr-only"
        aria-label={label}
        onChange={(event) => {
          const selected = event.target.files?.[0];
          if (selected) onFileChange(selected);
          event.target.value = "";
        }}
      />
      <button
        type="button"
        aria-label={file ? "Replace " + file.name : label}
        className={cn(
          "ui-focus-ring min-w-0 rounded-ui-md font-ui text-content-secondary",
          compact
            ? "flex h-control-md w-full items-center gap-ui-2 px-ui-2 text-left"
            : cn(
                "flex w-full flex-col items-center",
                dense
                  ? "gap-ui-1 p-ui-2 text-ui-md"
                  : "gap-ui-2 p-ui-4 text-ui-lg",
              ),
        )}
        onClick={() => inputRef.current?.click()}
      >
        {compact ? (
          <Paperclip className="size-ui-4 shrink-0 text-action-brand" />
        ) : (
          <FileUp
            className={cn(
              "text-action-brand",
              dense ? "size-ui-5" : "size-ui-6",
            )}
          />
        )}
        <span
          className={cn(
            "min-w-0 truncate",
            file && "font-code text-content-primary",
          )}
        >
          {file?.name ||
            (compact ? "Choose file…" : "Drop a file here or choose one")}
        </span>
        {file ? (
          <span className="shrink-0 font-code text-ui-xs text-content-tertiary">
            {file.size < 1024
              ? file.size + " B"
              : (file.size / 1024).toFixed(1) + " KB"}
          </span>
        ) : null}
        {file && compact ? (
          <span className="ml-auto text-ui-xs text-action-brand">Replace</span>
        ) : null}
      </button>
      {file && !compact ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          weight="normal"
          onClick={() => onFileChange(null)}
        >
          <X className="size-ui-3-5" />
          Remove file
        </Button>
      ) : null}
    </div>
  );
}
