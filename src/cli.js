import { readFile } from "node:fs/promises";
import { validateEvent } from "./contracts.js";

const [, , schemaPath, eventPath] = process.argv;
if (!schemaPath || !eventPath) {
  console.error("用法: node src/cli.js <schema.json> <event.json>");
  process.exitCode = 2;
} else {
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  const raw = JSON.parse(await readFile(eventPath, "utf8"));
  const events = Array.isArray(raw) ? raw : [raw];
  let failed = false;
  events.forEach((event, index) => {
    const issues = validateEvent(event, schema);
    for (const issue of issues) {
      failed = true;
      console.log(
        `[${index}] ${event.event_id ?? "?"}	${issue.field}	${issue.code}	${issue.message}`,
      );
    }
  });
  if (!failed) console.log("valid");
  else process.exitCode = 1;
}
