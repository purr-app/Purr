import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { resourceSchema, workspaceDefinitionSchema } from "../src/domain/project";

/** Native Git checks use the canonical shape, without maintaining a second schema. */
export function projectJsonSchema() {
  return JSON.stringify(z.toJSONSchema(z.strictObject({ workspace: workspaceDefinitionSchema, resources: z.array(resourceSchema) }), { io: "input" })) + "\n";
}
if (process.argv.includes("--write")) await writeFile(new URL("../src-tauri/schemas/project.json", import.meta.url), projectJsonSchema());
