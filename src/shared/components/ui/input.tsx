import * as React from "react";

import { cn } from "../../lib/cn";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

const Input = React.forwardRef<HTMLInputElement, InputProps>(({ className, type, ...props }, ref) => (
  <input
    className={cn(
      "focus-ring flex h-10 w-full rounded-md border border-transparent bg-transparent px-3 text-body-md text-foreground placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
    ref={ref}
    type={type}
    {...props}
  />
));
Input.displayName = "Input";

export { Input };
