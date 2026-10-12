import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { classifyExpression, isPureTemplateReference } from "../src/domain/template-expression";
import { credentialSchema } from "../src/domain/project";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/secret-classification.json", import.meta.url), "utf8")) as { value: string; pure: boolean }[];
for (const fixture of fixtures) test(`credential classification: ${JSON.stringify(fixture.value)}`, () => {
  assert.equal(isPureTemplateReference(fixture.value), fixture.pure);
  const classified = classifyExpression(fixture.value);
  assert.equal(classified.kind === "template", fixture.pure);
  assert.equal(classified.value, fixture.value);
  assert.equal(credentialSchema.safeParse({ kind: "template", value: fixture.value }).success, fixture.pure);
});
