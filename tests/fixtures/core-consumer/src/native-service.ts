import { invoke } from "@tauri-apps/api/core";

export const consumerNativeService = Object.freeze({
  ping: () => invoke<string>("plugin:consumer-fixture|ping"),
});
