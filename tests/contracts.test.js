import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateEvent } from "../src/contracts.js";

const schema = JSON.parse(await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));
const sample = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));

test("中文样例通过校验", () => assert.deepEqual(validateEvent(sample, schema), []));
test("缺少字段时稳定排序", () => {
  const issues = validateEvent({}, schema);
  assert.deepEqual(issues.map((x) => x.field), issues.map((x) => x.field).toSorted());
});
test("时间和版本边界", () => {
  const issues = validateEvent({ ...sample, occurred_at: "2026-09-25T10:00:00", version: 0 }, schema);
  assert.ok(issues.some((x) => x.field === "occurred_at" && x.code === "timezone_required"));
  assert.ok(issues.some((x) => x.field === "version" && x.code === "positive_integer"));
});
test("事件载荷必填", () => {
  const issues = validateEvent({ ...sample, event_type: "CLAIM_PROPOSED", payload: {} }, schema);
  assert.ok(issues.some((x) => x.field === "payload.claim_kind" && x.code === "required"));
});
test("未知事件类型被拒绝", () => {
  const issues = validateEvent({ ...sample, event_type: "UNKNOWN" }, schema);
  assert.ok(issues.some((x) => x.field === "event_type" && x.code === "unsupported_value"));
});
