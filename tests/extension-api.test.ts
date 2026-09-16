import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { createPurrApp } from "@purr/core/app";
import { defineExtensionModule, type PurrExtensionModule } from "@purr/core/extension-api";
import { createExtensionRegistry } from "@purr/core/test-kit";
import type { ResponseContentPort } from "../src/application/ports/response-content";
import { fakeExtensionModule } from "./fixtures/extensions/fake-module";

const unavailable = () => Promise.reject(new Error("unused extension test capability"));
const capabilities = {
  httpTransport: unavailable,
  responseContent: {
    inspect: unavailable, readRange: unavailable, readLines: unavailable, search: unavailable, format: unavailable,
    query: unavailable, save: unavailable, mediaUrl: () => "", release: async () => {},
  } satisfies ResponseContentPort,
};
const module = (id: string, register: PurrExtensionModule["register"] = () => {}): PurrExtensionModule =>
  defineExtensionModule({ manifest: { id, extensionApi: 1, version: "1.0.0" }, register });

test("a fake external module composes only through documented public exports", async () => {
  const source = await readFile(new URL("./fixtures/extensions/fake-module.tsx", import.meta.url), "utf8");
  const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
  assert.deepEqual(imports.filter((value) => value.startsWith("@purr/core")), ["@purr/core/extension-api", "@purr/core/ui"]);
  const registry = createExtensionRegistry([fakeExtensionModule], capabilities);
  assert.deepEqual(registry.modules.map((item) => item.id), ["test.fake"]);
  assert.equal(registry.integration("test.fake")?.label, "Synthetic provider");
  assert.equal(registry.pages[0].fullPath, "/extensions/test.fake/dashboard");
  assert.equal(registry.documentType("test.fake.protocol")?.controller.createNew().name, "Synthetic protocol");
  assert.ok(Object.isFrozen(registry));
  assert.ok(Object.isFrozen(registry.pages));
  assert.ok(Object.isFrozen(registry.pages[0]));
  assert.equal(typeof createPurrApp({ modules: [fakeExtensionModule] }), "function");
});

test("extension composition is atomic, validates collisions, and freezes captured registrars", () => {
  assert.deepEqual(createExtensionRegistry([], capabilities).modules, []);
  assert.throws(() => createExtensionRegistry([module("test.same"), module("test.same")], capabilities), /Duplicate extension module ID/);
  assert.throws(() => createExtensionRegistry([{ ...module("test.future"), manifest: { id: "test.future", extensionApi: 2, version: "1" } } as unknown as PurrExtensionModule], capabilities), /unsupported extension API/);
  const integrationPresentation = (id: string) =>
    module(id, (registrar) => registrar.integrations.register({ id: "shared.provider", label: id }));
  assert.throws(
    () => createExtensionRegistry([integrationPresentation("test.one"), integrationPresentation("test.two")], capabilities),
    /Duplicate integration presentation ID/,
  );
  const duplicatePage = module("test.pages", (registrar) => {
    const page = { id: "home", routeSegment: "home", title: "Home", create: () => ({ component: () => null }) };
    registrar.pages.register(page); registrar.pages.register({ ...page, id: "other" });
  });
  assert.throws(() => createExtensionRegistry([duplicatePage], capabilities), /Duplicate application route path/);
  const duplicatePageId = module("test.page-ids", (registrar) => {
    registrar.pages.register({ id: "home", routeSegment: "home", title: "Home", create: () => ({ component: () => null }) });
    registrar.pages.register({ id: "home", routeSegment: "other", title: "Other", create: () => ({ component: () => null }) });
  });
  assert.throws(() => createExtensionRegistry([duplicatePageId], capabilities), /Duplicate extension page ID/);
  const duplicateDocument = (id: string) => module(id, (registrar) => registrar.documentTypes.register({ extensionType: "shared.document", label: id,
    validateAndMigrate: (configVersion, config) => ({ configVersion, config }), create: () => ({ editor: () => null, createNew: () => ({ name: id, configVersion: 1, config: {} }) }) }));
  assert.throws(() => createExtensionRegistry([duplicateDocument("test.doc-one"), duplicateDocument("test.doc-two")], capabilities), /Duplicate extension document type/);
  let lateRegister: (() => void) | undefined;
  createExtensionRegistry([
    module("test.freeze", (registrar) => {
      lateRegister = () => registrar.integrations.register({ id: "test.late", label: "Late" });
    }),
  ], capabilities);
  assert.throws(() => lateRegister?.(), /registries are frozen/);
  assert.equal(createExtensionRegistry([module("test.clean")], capabilities).modules.length, 1);
});
