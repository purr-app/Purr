/** Optional distribution adapter. Core never chooses an update server or trust key. */
export interface AppUpdater {
  check(): Promise<AppUpdate | null>;
  restart(): Promise<void>;
}
export interface AppUpdate {
  version: string;
  notes: string;
  download(onProgress: (received: number, total?: number) => void): Promise<void>;
  install(): Promise<void>;
  close(): Promise<void>;
}
export type UpdateState = {
  phase: "disabled" | "idle" | "checking" | "available" | "downloading" | "downloaded" | "installing" | "installed";
  version?: string;
  notes?: string;
  received: number;
  total?: number;
  notice?: "update" | "current" | "error";
  error?: string;
};

/** One controller per app composition: startup and concurrent clicks are deduplicated. */
export class UpdateController {
  private state: UpdateState;
  private listeners = new Set<() => void>();
  private update?: AppUpdate;
  private started = false;
  private busy = false;
  private prepareRestart: () => Promise<void> = async () => {};
  beforeRestart(callback: () => Promise<void>) {
    this.prepareRestart = callback;
    return () => { if (this.prepareRestart === callback) this.prepareRestart = async () => {}; };
  }
  constructor(private readonly updater?: AppUpdater) {
    this.state = { phase: updater ? "idle" : "disabled", received: 0 };
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private set(change: Partial<UpdateState>) {
    this.state = { ...this.state, ...change };
    this.listeners.forEach((listener) => listener());
  }
  start() {
    if (this.started) return;
    this.started = true;
    void this.check(false);
  }
  dismiss = () => this.set({ notice: undefined });
  check = async (manual = true) => {
    if (!this.updater || this.busy) return;
    if (["downloaded", "installed"].includes(this.state.phase)) {
      this.set({ notice: "update" });
      return;
    }
    this.busy = true;
    const previous = this.state.phase;
    this.set({ phase: "checking", error: undefined, notice: undefined });
    try {
      const next = await this.updater.check();
      const old = this.update;
      this.update = next ?? undefined;
      // Cleanup failures must not hide a successfully checked update.
      if (old && old !== next) await old.close().catch(() => {});
      this.set({ phase: next ? "available" : "idle", version: next?.version, notes: next?.notes,
        received: 0, total: undefined, notice: next ? "update" : manual ? "current" : undefined });
    } catch {
      this.set({ phase: previous, notice: "error", error: "Could not check for updates. Check your connection and try again." });
    } finally { this.busy = false; }
  };
  download = async () => {
    if (!this.update || this.busy || this.state.phase !== "available") return;
    this.busy = true;
    this.set({ phase: "downloading", received: 0, total: undefined, notice: "update", error: undefined });
    try {
      await this.update.download((received, total) => this.set({ received, total }));
      this.set({ phase: "downloaded", notice: "update" });
    } catch {
      this.set({ phase: "available", notice: "error", error: "Could not download or verify the update. Try downloading again." });
    } finally { this.busy = false; }
  };
  /** Installation and relaunch only follow an explicit Restart action. */
  restart = async () => {
    if (!this.update || !this.updater || this.busy || !["downloaded", "installed"].includes(this.state.phase)) return;
    this.busy = true;
    let step: "save" | "install" | "restart" = "save";
    try {
      await this.prepareRestart();
      if (this.state.phase !== "installed") {
        this.set({ phase: "installing", notice: "update", error: undefined });
        step = "install";
        await this.update.install();
        this.set({ phase: "installed" });
      }
      step = "restart";
      await this.updater.restart();
    } catch {
      this.set({ phase: this.state.phase === "installed" ? "installed" : "downloaded", notice: "error",
        error: {
          save: "Could not save your workspace. Resolve the save error before restarting to update.",
          install: "Could not install the update. Try Restart again.",
          restart: "The update is installed, but Purr could not restart. Try Restart again or close and reopen Purr.",
        }[step] });
    } finally { this.busy = false; }
  };
  activate = async () => {
    if (this.state.phase === "available") await this.download();
    else if (["downloaded", "installed"].includes(this.state.phase)) await this.restart();
    else await this.check();
  };
}
