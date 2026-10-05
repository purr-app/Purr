import assert from "node:assert/strict";
import test from "node:test";
import { templateSegments, templateTokens } from "../src/shared/lib/template-tokens";

test("template spans include braces and whitespace without resolving values", () => {
  assert.deepEqual(templateTokens("x{{ token }}-{{other}}"), [
    { from: 1, to: 12, text: "{{ token }}", name: "token" },
    { from: 13, to: 22, text: "{{other}}", name: "other" },
  ]);
  assert.equal(templateTokens("{{unfinished").length, 0);
});

test("mixed credentials reveal only template references", () => {
  assert.deepEqual(templateSegments("secret:{{ token }} private", true), [
    { text: "•••••••", variable: false },
    { text: "{{ token }}", variable: true },
    { text: " •••••••", variable: false },
  ]);
  assert.equal(templateSegments("secret:{{ token }} private").map((part) => part.text).join(""), "secret:{{ token }} private");
});
