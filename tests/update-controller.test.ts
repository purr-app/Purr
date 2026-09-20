import assert from "node:assert/strict";
import test from "node:test";
import { UpdateController, type AppUpdate, type AppUpdater } from "../src/features/updates/update-controller";

function fixture() {
  const calls: string[] = [];
  const update: AppUpdate = {
    version: "0.1.2", notes: "Faster responses",
    download: async (progress) => { calls.push("download"); progress(5, 10); },
    install: async () => { calls.push("install"); },
    close: async () => { calls.push("close"); },
  };
  const updater: AppUpdater = { check: async () => { calls.push("check"); return update; }, restart: async () => { calls.push("restart"); } };
  return { calls, update, updater, controller: new UpdateController(updater) };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
test("source builds are disabled; startup checks once and never downloads", async () => {
  const disabled = new UpdateController();
  disabled.start(); await disabled.activate();
  assert.equal(disabled.getSnapshot().phase, "disabled");
  const { controller, calls } = fixture();
  controller.start(); controller.start(); await tick();
  assert.deepEqual(calls, ["check"]);
  assert.equal(controller.getSnapshot().notice, "update");
  controller.dismiss();
  assert.equal(controller.getSnapshot().phase, "available");
  assert.equal(controller.getSnapshot().notice, undefined);
});
test("download never installs; explicit restart saves, installs, then relaunches", async () => {
  const { controller, calls } = fixture();
  await controller.check();
  controller.beforeRestart(async () => { calls.push("save"); });
  await controller.activate();
  assert.equal(controller.getSnapshot().phase, "downloaded");
  assert.equal(controller.getSnapshot().received, 5);
  assert.deepEqual(calls, ["check", "download"]);
  await controller.check(); // Manual About check must preserve downloaded bytes.
  assert.equal(controller.getSnapshot().phase, "downloaded");
  await controller.activate();
  assert.deepEqual(calls, ["check", "download", "save", "install", "restart"]);
});
test("overlapping checks and downloads are deduplicated", async () => {
  const { controller, updater, calls } = fixture();
  let finish!: () => void;
  const original = updater.check;
  updater.check = async () => { await new Promise<void>((resolve) => { finish = resolve; }); return original(); };
  const first = controller.check();
  await controller.check();
  finish(); await first;
  await Promise.all([controller.download(), controller.download()]);
  assert.deepEqual(calls, ["check", "download"]);
});
test("network, verification, save, and relaunch errors retain a retryable state", async () => {
  const { controller, updater, update, calls } = fixture();
  const check = updater.check;
  updater.check = async () => { throw new Error("network"); };
  await controller.check();
  assert.equal(controller.getSnapshot().phase, "idle");
  assert.equal(controller.getSnapshot().notice, "error");
  updater.check = check; await controller.check();
  const download = update.download;
  update.download = async () => { throw new Error("bad signature"); };
  await controller.download();
  assert.equal(controller.getSnapshot().phase, "available");
  assert.equal(controller.getSnapshot().notice, "error");
  update.download = download; await controller.download();
  const releaseGuard = controller.beforeRestart(async () => { throw new Error("save failed"); });
  await controller.restart();
  assert.equal(controller.getSnapshot().phase, "downloaded");
  assert.ok(!calls.includes("install"));
  releaseGuard();
  updater.restart = async () => { calls.push("restart"); throw new Error("relaunch failed"); };
  await controller.restart(); await controller.restart();
  assert.equal(controller.getSnapshot().phase, "installed");
  assert.equal(calls.filter((call) => call === "install").length, 1);
  assert.equal(calls.filter((call) => call === "restart").length, 2);
});
test("no-update feedback is silent at startup and explicit after a manual check", async () => {
  const { controller, updater } = fixture();
  updater.check = async () => null;
  await controller.check(false);
  assert.equal(controller.getSnapshot().notice, undefined);
  await controller.check();
  assert.equal(controller.getSnapshot().notice, "current");
});
