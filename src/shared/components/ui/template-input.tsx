import { forwardRef, useLayoutEffect, useRef } from "react";
import { cn } from "../../lib/cn";
import { templateSegments, templateTokens } from "../../lib/template-tokens";
import { useTemplateVariableActions } from "./template-variable-context";
import { TemplateVariablePopover } from "./template-variable-popover";
import { Input, inputVariants, type InputProps } from "./input";

/** One native input retains selection and IME; a non-interactive layer styles templates. */
const TemplateInputControl = forwardRef<HTMLInputElement, InputProps & { maskLiterals?: boolean }>(function TemplateInput({ value, className, maskLiterals = false, onScroll, variant, ...props }, ref) {
  const input = useRef<HTMLInputElement | null>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const text = String(value ?? "");
  const highlighted = templateTokens(text).length > 0;
  const syncScroll = () => { if (overlay.current && input.current) overlay.current.scrollLeft = input.current.scrollLeft; };
  useLayoutEffect(syncScroll, [value]);
  return <div className={cn("relative min-w-0", className?.includes("flex-1") && "flex-1", className?.includes("h-full") && "h-full")}>
    {highlighted ? <div ref={overlay} aria-hidden="true" data-template-overlay className={cn(inputVariants({ variant }), className, "pointer-events-none absolute inset-0 items-center overflow-hidden border-transparent bg-transparent")}>
      <span className="whitespace-pre">{templateSegments(text, maskLiterals).map((segment, index) => <span key={index} className={segment.variable ? "text-accent-orange italic" : undefined}>{segment.text}</span>)}</span>
    </div> : null}
    <Input {...props} value={value} variant={variant} ref={(node) => {
      input.current = node;
      if (typeof ref === "function") ref(node); else if (ref) ref.current = node;
    }} onScroll={(event) => { syncScroll(); onScroll?.(event); }}
      className={cn(className, highlighted && "text-transparent caret-content-primary selection:text-transparent")}
      type={highlighted ? "text" : props.type} />
  </div>;
});

/** Template-enabled fields inherit completion, hover, and definition navigation. */
export const TemplateInput = forwardRef<HTMLInputElement, InputProps & { maskLiterals?: boolean }>(function TemplateInput(props, ref) {
  const actions = useTemplateVariableActions();
  const input = useRef<HTMLInputElement | null>(null);
  const assignRef = (node: HTMLInputElement | null) => {
    input.current = node;
    if (typeof ref === "function") ref(node); else if (ref) ref.current = node;
  };
  if (!actions || props.disabled || props.readOnly || !props.onChange) return <TemplateInputControl {...props} ref={assignRef} />;
  return <TemplateVariablePopover value={String(props.value ?? "")} actions={actions} inputRef={assignRef} onInputChange={props.onChange}
    onValueChange={(value) => {
      const node = input.current;
      if (!node) return;
      // Use a native input event so consumers keep the ordinary onChange contract.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, value);
      node.dispatchEvent(new Event("input", { bubbles: true }));
    }}>
    {(bindings) => <TemplateInputControl {...props} {...bindings}
      onClick={(event) => { props.onClick?.(event); if (!event.defaultPrevented) bindings.onClick(event); }}
      onKeyUp={(event) => { props.onKeyUp?.(event); if (!event.defaultPrevented) bindings.onKeyUp(event); }}
      onKeyDown={(event) => { bindings.onKeyDown(event); if (!event.defaultPrevented) props.onKeyDown?.(event); }} />}
  </TemplateVariablePopover>;
});
