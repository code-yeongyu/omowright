import assert from "node:assert/strict";
import { mkdtempSync, rmSync, globSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { connectPipe, createAgentTabs, createCaptcha } from "../../src/index.ts";

interface InputReceipt {
  type: string;
  trusted: boolean;
  buttons: number | undefined;
}

interface RecordedEvent {
  type: string;
  target: string;
  trusted: boolean;
  x: number;
  y: number;
  buttons: number;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface WaitResult {
  outcome: string;
}

interface QaPage {
  evaluate<R>(fn: () => R): Promise<Awaited<R>>;
  evaluate<R, A>(fn: (arg: A) => R, arg: A): Promise<Awaited<R>>;
}

export interface ScenarioResult {
  scenario: string;
  passed: boolean;
  foreground?: { visible: string; focused: boolean };
  clickEvent?: InputReceipt;
  checked?: boolean;
  releaseEvent?: InputReceipt;
  sliderValue?: number;
  inputReceipt?: InputReceipt;
  acceptance?: WaitResult;
  denied?: WaitResult;
  cancelled?: WaitResult;
  events?: RecordedEvent[];
  error?: string;
}

const html = `<!doctype html><html><body style="font:20px sans-serif;margin:40px">
<h1>CAPTCHA interaction fixture</h1>
<div id="captcha-widget" style="width:300px;height:80px;border:1px solid;display:flex;align-items:center;gap:20px">
<input id="captcha-checkbox" type="checkbox" style="width:24px;height:24px;margin:12px"><span>Confirm input</span></div>
<p id="application-status" data-accepted="false">Application: pending</p>
<input id="slider-handle" type="range" min="0" max="100" value="0" style="width:300px">
<script>
window.events=[];
for(const type of ['mousemove','mousedown','mouseup','click','change','input']){
  document.addEventListener(type,e=>events.push({type,target:e.target.id,trusted:e.isTrusted,x:e.clientX,y:e.clientY,buttons:e.buttons}));
}
window.accept=()=>{const el=document.getElementById('application-status');el.dataset.accepted='true';el.textContent='Application: accepted';};
</script></body></html>`;

async function boundsOf(page: QaPage, selector: string): Promise<Rect> {
  return page.evaluate((selector: string) => {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`missing ${selector}`);
    const r = element.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, selector);
}

async function arm(page: QaPage, type: string) {
  await page.evaluate((type: string) => {
    const nextInput = new Promise<InputReceipt>((resolve, reject) => {
      const listener = (e: Event) => {
        clearTimeout(timer);
        resolve({ type: e.type, trusted: e.isTrusted, buttons: e instanceof MouseEvent ? e.buttons : undefined });
      };
      const timer = setTimeout(() => {
        document.removeEventListener(type, listener);
        reject(Error("input event missing"));
      }, 5000);
      document.addEventListener(type, listener, { once: true });
    });
    Reflect.set(window, "nextInput", nextInput);
    nextInput.catch(() => {});
  }, type);
}

export async function runScenario(scenario: string, evidenceDir?: string): Promise<ScenarioResult> {
  if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });
  const profile = mkdtempSync(path.join(tmpdir(), "omowright-captcha-qa-"));
  const browserPath =
    process.env.SHELL_BIN ??
    globSync(
      path.join(
        homedir(),
        "Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell",
      ),
    )
      .sort()
      .at(-1);
  assert.ok(browserPath, "A real Chromium binary is required");
  let browser: Awaited<ReturnType<typeof connectPipe>> | undefined;
  const result: ScenarioResult = { scenario, passed: false };
  try {
    const browserArgs: string[] = ["--headless", "--no-first-run", `--user-data-dir=${profile}`];
    browser = await connectPipe({ browserPath, browserArgs, storageRoot: profile });
    const { page } = await createAgentTabs(browser).create("about:blank");
    await page.goto(`data:text/html,${encodeURIComponent(html)}`);
    await page._sendToTarget("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.refreshViewportSize();
    await page.bringToFront();
    result.foreground = await page.evaluate(() => ({
      visible: document.visibilityState,
      focused: document.hasFocus(),
    }));
    assert.deepEqual(result.foreground, { visible: "visible", focused: true });
    const captcha = createCaptcha(page);
    const box = await boundsOf(page, "#captcha-widget");
    const checkbox = await boundsOf(page, "#captcha-checkbox");
    const point = { x: checkbox.x + checkbox.width / 2, y: checkbox.y + checkbox.height / 2 };
    if (evidenceDir) writeFileSync(path.join(evidenceDir, "before.png"), await page.screenshot({ type: "png" }));
    if (scenario === "targeting") {
      await captcha.click(box, { settleMs: 0 });
      assert.equal(
        await page.evaluate(() => document.querySelector<HTMLInputElement>("#captcha-checkbox")?.checked),
        false,
        "legacy center is unchanged",
      );
      await arm(page, "click");
      await captcha.click(box, { point, approachSteps: 12, settleMs: 0 });
      const clickEvent: InputReceipt = await page.evaluate((): Promise<InputReceipt> =>
        Reflect.get(window, "nextInput"),
      );
      result.clickEvent = clickEvent;
      result.checked = await page.evaluate(
        () => document.querySelector<HTMLInputElement>("#captcha-checkbox")?.checked,
      );
      if (evidenceDir) writeFileSync(path.join(evidenceDir, "after.png"), await page.screenshot({ type: "png" }));
      assert.equal(result.checked, true, "explicit point must check the checkbox");
      assert.equal(clickEvent.trusted, true);
      const slider = await boundsOf(page, "#slider-handle");
      await arm(page, "mouseup");
      await captcha.drag(
        { x: slider.x + 8, y: slider.y + slider.height / 2 },
        { x: slider.x + slider.width - 8, y: slider.y + slider.height / 2 },
        { steps: 12, settleMs: 0 },
      );
      const releaseEvent: InputReceipt = await page.evaluate((): Promise<InputReceipt> =>
        Reflect.get(window, "nextInput"),
      );
      result.releaseEvent = releaseEvent;
      const sliderValue: number = await page.evaluate(() =>
        Number(document.querySelector<HTMLInputElement>("#slider-handle")?.value),
      );
      result.sliderValue = sliderValue;
      assert.equal(releaseEvent.trusted, true);
      assert.equal(releaseEvent.buttons, 0);
      assert.ok(sliderValue > 80);
      const eventsBefore = await page.evaluate((): number => Reflect.get(window, "events").length);
      await assert.rejects(captcha.click(box, { point: { x: box.x - 1, y: box.y }, settleMs: 0 }));
      assert.equal(await page.evaluate((): number => Reflect.get(window, "events").length), eventsBefore);
    } else if (scenario === "completion") {
      await arm(page, "change");
      await captcha.click(box, { point, approachSteps: 12, settleMs: 0 });
      const inputReceipt: InputReceipt = await page.evaluate((): Promise<InputReceipt> =>
        Reflect.get(window, "nextInput"),
      );
      result.inputReceipt = inputReceipt;
      assert.equal(inputReceipt.trusted, true);
      assert.equal(
        await page.evaluate(() => document.querySelector<HTMLElement>("#application-status")?.dataset.accepted),
        "false",
      );
      assert.equal(typeof captcha.waitFor, "function", "captcha must support explicit completion waiting");
      const entered = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      let settled = false;
      let first = true;
      const pending = captcha
        .waitFor({
          until: async (p) => {
            const accepted = await p.evaluate(
              () => document.querySelector<HTMLElement>("#application-status")?.dataset.accepted === "true",
            );
            if (first) {
              first = false;
              entered.resolve();
              await gate.promise;
            }
            return accepted;
          },
          timeoutMs: 5000,
          pollMs: 1,
        })
        .then((value) => {
          settled = true;
          return value;
        });
      await entered.promise;
      assert.equal(settled, false, "input receipt is not acceptance");
      await page.evaluate((): void => Reflect.get(window, "accept")());
      gate.resolve();
      const acceptance: WaitResult = await pending;
      result.acceptance = acceptance;
      assert.equal(acceptance.outcome, "matched");
      const denied: WaitResult = await captcha.waitFor({
        until: (p) => p.evaluate(() => false),
        timeoutMs: 20,
        pollMs: 1,
      });
      result.denied = denied;
      assert.equal(denied.outcome, "timed_out");
      const controller = new AbortController();
      controller.abort();
      const cancelled: WaitResult = await captcha.waitFor({
        until: () => {
          throw Error("pre-abort predicate ran");
        },
        signal: controller.signal,
      });
      result.cancelled = cancelled;
      assert.equal(cancelled.outcome, "cancelled");
      if (evidenceDir) writeFileSync(path.join(evidenceDir, "after.png"), await page.screenshot({ type: "png" }));
    } else {
      throw new Error(`Unknown scenario: ${scenario}`);
    }
    result.events = await page.evaluate((): RecordedEvent[] => Reflect.get(window, "events"));
    result.passed = true;
    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    if (browser) await browser.close();
    rmSync(profile, { recursive: true, force: true });
    if (evidenceDir) {
      writeFileSync(path.join(evidenceDir, "surface.json"), JSON.stringify(result, null, 2));
      writeFileSync(
        path.join(evidenceDir, "cleanup.json"),
        JSON.stringify({ browserClosed: Boolean(browser), profileRemoved: !existsSync(profile), profile }, null, 2),
      );
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const flag = process.argv.indexOf("--scenario");
  const scenario = flag < 0 ? "all" : (process.argv[flag + 1] ?? "all");
  for (const name of scenario === "all" ? ["targeting", "completion"] : [scenario]) {
    const dir = process.env.CAPTCHA_EVIDENCE_DIR;
    await runScenario(name, dir && (scenario === "all" ? path.join(dir, name) : dir));
  }
  console.log(`PASS ${scenario}`);
}
