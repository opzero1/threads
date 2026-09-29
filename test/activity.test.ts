import { expect, test } from "bun:test";
import {
  activityTime,
  cleanRoleTitle,
} from "../src/activity-model";

test("row times prefer the last execution over title-cleanup updates", () => {
  expect(activityTime({ created: 1, idle: 5, updated: 9 })).toBe(5);
  expect(activityTime({ created: 1, updated: 2 })).toBe(2);
});
test("legacy cleanup requires managed identity, strips exactly once and retains the remainder", () => {
  expect(cleanRoleTitle("[Main] Ordinary", false)).toBe("[Main] Ordinary");
  expect(cleanRoleTitle("[Worker] Review auth", true)).toBe("Review auth");
  expect(cleanRoleTitle("[Main] [Worker] User remainder", true)).toBe(
    "[Worker] User remainder",
  );
  expect(cleanRoleTitle("[Main]  Keep spaces ", true)).toBe(" Keep spaces ");
  expect(cleanRoleTitle("[Main] ", true)).toBe("[Main] ");
  expect(cleanRoleTitle("A renamed worker", true)).toBe("A renamed worker");
});
