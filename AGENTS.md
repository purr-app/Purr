# Purr UI system guardrails

All UI work must use the Purr design system declared in `src/styles/globals.css` and exposed by `tailwind.config.ts`.

- Use only the named palette tokens: `purr`, `border`, `content`, `action`, `accent`, `syntax`, `method`, `status`, and `mac`. Reuse `accent` for a raw palette colour outside its method or status meaning; do not repurpose `method-*` colours for generic UI. Code editors use the `syntax` and `editor-*` theme tokens through `src/shared/theme/code-editor-theme.ts`.
- Do not introduce hex, RGB/RGBA, HSL colours, Tailwind arbitrary colour values, or new colour names in component files. Add an approved token first when a new semantic role is genuinely needed.
- Use `font-ui` (Space Grotesk) for application UI and `font-code` (Google Sans Code) for URLs, HTTP methods, shortcuts, headers, bodies, payloads, and other protocol/code content.
- Use the `ui-*` spacing, radius, control-height, typography, duration, and shadow tokens. Do not use arbitrary pixel values for visual geometry. Add a rem-based token in `globals.css` and expose it in Tailwind if the current scale is insufficient.
- Use `ui-focus-ring` for focusable controls. Focus colours, borders, surfaces, and interaction states must come from the theme tokens.
- Reuse components from `src/shared/components/ui` and add shared primitives there rather than duplicating control styling in feature code.
- Keep the dark Obsidian theme as the active theme until a complete, tokenized alternative theme is explicitly introduced.
