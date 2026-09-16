import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ApplicationServicesProvider,
  useApplicationServices,
} from "../src/app/application-services-context";
import type { ApplicationServices } from "../src/app/composition/application-services";
import {
  createAppComposition,
  type AppRouteDefinition,
} from "../src/app/composition/routes";
import { createPurrApp } from "../src/app/create-purr-app";
import { WorkspacePersistence } from "../src/application/workspace-persistence";
import type { ResponseContentRef } from "../src/domain/http";
import { MemorySecureStore } from "../src/storage/secrets";
import { MemoryPersistenceBackend } from "./helpers/memory-persistence";

const unavailable = () => Promise.reject(new Error("unused test port"));

function memoryServices(): ApplicationServices {
  const secureStore = new MemorySecureStore();
  const persistence = new WorkspacePersistence(
    new MemoryPersistenceBackend(),
    secureStore,
  );
  return Object.freeze({
    observability: { integrations: async () => [], trace: unavailable },
    persistence,
    secureStore,
    credentialResolver: {
      resolve: async (credential) =>
        credential.kind === "plain"
          ? credential.value
          : (await persistence.secure.get(credential.ref)) ?? "",
    },
    httpTransport: unavailable,
    responseContent: {
      inspect: unavailable,
      readRange: unavailable,
      readLines: unavailable,
      search: unavailable,
      format: unavailable,
      query: unavailable,
      save: unavailable,
      release: async (_reference: ResponseContentRef) => unavailable(),
    },
    oauthCallback: { authorize: unavailable, cancel: async () => {} },
    imports: { normalize: unavailable },
    downloads: { saveInlineResponse: unavailable },
    importDialog: { choosePath: async () => null },
    workspaceShell: { openWorkspaceFolder: async () => {} },
    lifecycle: {
      onCloseRequested: async () => () => {},
      exit: async () => {},
    },
    runtime: Object.freeze({ kind: "browser", os: "other" }),
  });
}

test("application services context accepts memory adapters at the shell", () => {
  const services = memoryServices();
  function Probe() {
    return createElement("span", null, useApplicationServices().runtime.kind);
  }
  const output = renderToStaticMarkup(
    createElement(
      ApplicationServicesProvider,
      { services },
      createElement(Probe),
    ),
  );
  assert.equal(output, "<span>browser</span>");
});

test("route composition is validated and frozen before rendering", () => {
  const component = () => null;
  const route: AppRouteDefinition = {
    id: "test.future-page",
    path: "/extensions/test/page",
    component,
  };
  const composition = createAppComposition([route]);
  assert.deepEqual(
    composition.routes.map(({ id, path }) => ({ id, path })),
    [
      { id: "core.workbench", path: "/workbench" },
      { id: route.id, path: route.path },
    ],
  );
  assert.ok(Object.isFrozen(composition));
  assert.ok(Object.isFrozen(composition.routes));
  assert.ok(composition.routes.every(Object.isFrozen));
  assert.throws(
    () => createAppComposition([{ ...route, id: "core.workbench" }]),
    /Duplicate application route ID/,
  );
  assert.throws(
    () => createAppComposition([{ ...route, path: "/workbench" }]),
    /Duplicate application route path/,
  );
  assert.equal(
    typeof createPurrApp({ composition, services: memoryServices() }),
    "function",
  );
});
