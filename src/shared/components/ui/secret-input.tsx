import { Check, Copy, Eye, EyeOff, KeyRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "./button";
import { Input, type InputProps } from "./input";
import { cn } from "../../lib/cn";

export function SecretInput({ className, ...props }: Omit<InputProps, "type">) {
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const label = String(props["aria-label"] ?? "secret");
  return (
    <div className={cn("min-w-0", className)}>
      <div className="flex h-control-lg min-w-0 items-center gap-ui-2 overflow-hidden rounded-ui-lg border border-border-subtle bg-purr-elevated px-ui-2 focus-within:border-action-brand">
        <KeyRound
          className="size-ui-3-5 shrink-0 text-content-tertiary"
          aria-hidden="true"
        />
        <Input
          {...props}
          type={visible ? "text" : "password"}
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          variant="transparent"
          className="h-full min-w-0 flex-1 px-ui-1 font-code"
        />
        <div className="flex shrink-0 items-center gap-ui-1">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label={`${visible ? "Hide" : "Reveal"} ${label}`}
            aria-pressed={visible}
            disabled={props.disabled}
            onClick={() => setVisible(!visible)}
          >
            {visible ? (
              <EyeOff className="size-ui-4" />
            ) : (
              <Eye className="size-ui-4" />
            )}
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label={`Copy ${label}`}
            disabled={!props.value || props.disabled}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(String(props.value ?? ""));
                setCopied(true);
                setError("");
                clearTimeout(timer.current);
                timer.current = setTimeout(() => setCopied(false), 1800);
              } catch {
                setError(
                  "Clipboard unavailable. Reveal and select the value to copy it.",
                );
              }
            }}
          >
            {copied ? (
              <Check className="size-ui-4 text-action-brand" />
            ) : (
              <Copy className="size-ui-4" />
            )}
          </Button>
        </div>
      </div>
      {error ? (
        <p role="status" className="mt-ui-1 text-ui-xs text-accent-orange">
          {error}
        </p>
      ) : null}
    </div>
  );
}
