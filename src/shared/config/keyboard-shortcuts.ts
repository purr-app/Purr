/**
 * The default key bindings for the application.
 *
 * Keep this file as the single source of truth. A settings screen can persist
 * `KeyboardShortcutOverrides` and pass them to `createKeyboardShortcutConfig`
 * without changing the consumers of a shortcut.
 */
export type ShortcutKey = "mod" | "ctrl" | "alt" | "shift" | "enter" | "escape" | string;

export type KeyboardShortcut = {
  /** Binding syntax understood by react-hotkeys-hook. */
  hotkey: string;
  /** Semantic keys used by the platform-adaptive KbdGroup. */
  keys: readonly ShortcutKey[];
};

export const defaultKeyboardShortcuts = {
  openMethodSelector: { hotkey: "mod+shift+m", keys: ["mod", "shift", "m"] },
  dismissPopover: { hotkey: "esc", keys: ["escape"] },
  sendRequest: { hotkey: "mod+enter", keys: ["mod", "enter"] },
  pasteCurl: { hotkey: "mod+v", keys: ["mod", "v"] },
  importRequest: { hotkey: "mod+o", keys: ["mod", "o"] },
  openRecentRequest: { hotkey: "mod+p", keys: ["mod", "p"] },
  selectGetMethod: { hotkey: "1", keys: ["1"] },
  selectPostMethod: { hotkey: "2", keys: ["2"] },
  selectPutMethod: { hotkey: "3", keys: ["3"] },
  selectPatchMethod: { hotkey: "4", keys: ["4"] },
  selectDeleteMethod: { hotkey: "5", keys: ["5"] },
  selectHeadMethod: { hotkey: "h", keys: ["h"] },
  selectOptionsMethod: { hotkey: "0", keys: ["0"] },
  selectQueryMethod: { hotkey: "q", keys: ["q"] },
} as const satisfies Record<string, KeyboardShortcut>;

export type KeyboardShortcutId = keyof typeof defaultKeyboardShortcuts;
export type KeyboardShortcutConfig = Record<KeyboardShortcutId, KeyboardShortcut>;
export type KeyboardShortcutOverrides = Partial<Record<KeyboardShortcutId, Partial<KeyboardShortcut>>>;

export function createKeyboardShortcutConfig(overrides: KeyboardShortcutOverrides = {}): KeyboardShortcutConfig {
  return Object.fromEntries(
    Object.entries(defaultKeyboardShortcuts).map(([id, shortcut]) => [id, { ...shortcut, ...overrides[id as KeyboardShortcutId] }]),
  ) as KeyboardShortcutConfig;
}

export const keyboardShortcuts = createKeyboardShortcutConfig();

export const httpMethodShortcutIds = {
  GET: "selectGetMethod",
  POST: "selectPostMethod",
  PUT: "selectPutMethod",
  PATCH: "selectPatchMethod",
  DELETE: "selectDeleteMethod",
  HEAD: "selectHeadMethod",
  OPTIONS: "selectOptionsMethod",
  QUERY: "selectQueryMethod",
} as const satisfies Record<string, KeyboardShortcutId>;
