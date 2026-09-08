import { useId, type ReactNode } from "react";
import { Input, type InputProps } from "./input";
import { SecretInput } from "./secret-input";

export function FormField({
  label,
  hint,
  secret = false,
  ...props
}: InputProps & { label: string; hint?: ReactNode; secret?: boolean }) {
  const id = useId();
  const Control = secret ? SecretInput : Input;
  return (
    <div className="min-w-0 space-y-ui-2">
      <label
        htmlFor={id}
        className="block text-ui-xs font-medium text-content-secondary"
      >
        {label}
      </label>
      <Control
        {...props}
        id={id}
        aria-label={label}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className={
          secret
            ? "font-code"
            : "ui-focus-ring bg-purr-elevated font-code"
        }
        autoComplete="off"
        spellCheck={false}
      />
      {hint ? (
        <p id={`${id}-hint`} className="text-ui-xs text-content-tertiary">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
