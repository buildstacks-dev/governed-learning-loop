import { expect, test } from "vitest";
import { PROTOCOL_SCHEMA_VERSION } from "../src/index.js";

test("the kernel declares protocol schema version 1", () => {
  expect(PROTOCOL_SCHEMA_VERSION).toBe(1);
});
