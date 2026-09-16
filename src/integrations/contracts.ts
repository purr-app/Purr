export type ExtensionLogger = Readonly<{
  debug(message: string, details?: Readonly<Record<string, unknown>>): void;
  info(message: string, details?: Readonly<Record<string, unknown>>): void;
  warn(message: string, details?: Readonly<Record<string, unknown>>): void;
  error(message: string, details?: Readonly<Record<string, unknown>>): void;
}>;

// Frontend modules describe presentation only. Executable observability
// providers, config validation, credentials, correlation, parsing, and cache
// ownership belong to the native Rust registry and service.
export type IntegrationPresentationContribution = Readonly<{
  id: string;
  label: string;
}>;
