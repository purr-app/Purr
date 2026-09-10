import * as PopoverPrimitive from "@radix-ui/react-popover";
import * as React from "react";

import { cn } from "../../lib/cn";

const PopoverPortalContext = React.createContext<HTMLElement | null>(null);

export function PopoverPortalProvider({
  container,
  children,
}: {
  container: HTMLElement | null;
  children: React.ReactNode;
}) {
  return (
    <PopoverPortalContext.Provider value={container}>
      {children}
    </PopoverPortalContext.Provider>
  );
}

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;
const PopoverAnchor = PopoverPrimitive.Anchor;

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = "center", sideOffset = 0, ...props }, ref) => {
  const container = React.useContext(PopoverPortalContext);
  return (
    <PopoverPrimitive.Portal container={container ?? undefined}>
      <PopoverPrimitive.Content
        ref={ref}
        align={align}
        sideOffset={sideOffset}
        className={cn("z-50 outline-none", className)}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
});
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

export { Popover, PopoverAnchor, PopoverContent, PopoverTrigger };
