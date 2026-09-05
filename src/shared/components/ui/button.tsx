import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/cn";

const buttonVariants = cva(
  "ui-focus-ring inline-flex shrink-0 items-center justify-center gap-ui-2 whitespace-nowrap rounded-ui-md font-ui text-ui-md font-medium transition-colors duration-ui-fast disabled:pointer-events-none disabled:opacity-ui-disabled",
  {
    variants: {
      variant: {
        default: "bg-action-emerald text-purr-base shadow-button hover:bg-action-emerald-hover",
        secondary: "border border-border-subtle bg-purr-elevated text-content-secondary hover:bg-purr-highlight hover:text-content-primary",
        ghost: "text-content-secondary hover:bg-purr-highlight hover:text-content-primary",
      },
      size: {
        default: "h-control-md px-ui-4",
        sm: "h-control-sm px-ui-3",
        icon: "size-control-sm",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";

    return <Comp className={cn(buttonVariants({ variant, size }), className)} ref={ref} {...props} />;
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
