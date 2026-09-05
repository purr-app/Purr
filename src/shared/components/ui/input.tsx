import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/cn";

const inputVariants = cva(
  "flex h-control-lg w-full rounded-ui-md border px-ui-3 font-ui text-ui-md text-content-primary outline-none placeholder:text-content-tertiary disabled:cursor-not-allowed disabled:opacity-ui-disabled",
  {
    variants: {
      variant: {
        surface: "border-border-subtle bg-purr-elevated",
        transparent: "border-transparent bg-transparent",
      },
    },
    defaultVariants: {
      variant: "surface",
    },
  },
);

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement>,
    VariantProps<typeof inputVariants> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(({ className, type, variant, ...props }, ref) => (
  <input
    className={cn(inputVariants({ variant }), className)}
    ref={ref}
    type={type}
    {...props}
  />
));
Input.displayName = "Input";

export { Input, inputVariants };
