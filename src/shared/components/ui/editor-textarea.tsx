import * as React from "react";
import { cn } from "../../lib/cn";

/**
 * Full editor surfaces use their caret and editing state as focus affordances.
 * Keeping that behavior in one primitive prevents control-style focus borders
 * from being applied around an entire code or documentation canvas.
 */
export const EditorTextarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => <textarea
    ref={ref}
    className={cn("ui-editor-surface h-full w-full resize-none border-0 bg-purr-codefield px-ui-4 py-ui-4 font-code text-ui-md text-content-primary placeholder:text-content-quaternary", className)}
    {...props}
  />,
);
EditorTextarea.displayName = "EditorTextarea";
