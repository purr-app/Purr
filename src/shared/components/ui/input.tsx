import * as React from "react";

import { cn } from "../../lib/cn";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

const Input = React.forwardRef<HTMLInputElement, InputProps>(({ className, type, ...props }, ref) => (
  <input
    className={cn(
      "ui-focus-ring flex h-control-lg w-full rounded-ui-md border border-border-subtle bg-purr-elevated px-ui-3 font-ui text-ui-md text-content-primary placeholder:text-content-tertiary disabled:cursor-not-allowed disabled:opacity-ui-disabled focus-visible:border-border-focus",
      className,
    )}
    ref={ref}
    type={type}
    {...props}
  />
));
Input.displayName = "Input";

export { Input };
