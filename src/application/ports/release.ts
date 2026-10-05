/** Metadata for the running product, independent of the core dependency version. */
export type AppRelease = Readonly<{
  version: string;
  notes: string;
  date?: string;
}>;
