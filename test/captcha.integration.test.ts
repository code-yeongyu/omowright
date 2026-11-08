import { test } from "node:test";
import { runScenario } from "./fixtures/captcha-quality-qa.ts";

test("captcha explicit targeting reaches the real checkbox with trusted input", { timeout: 30000 }, async () => {
  await runScenario("targeting", undefined);
});

test("captcha completion distinguishes input receipt from application acceptance", { timeout: 30000 }, async () => {
  await runScenario("completion", undefined);
});
