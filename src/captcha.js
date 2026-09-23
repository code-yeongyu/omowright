import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compactSnapshot } from "./llm.js";

const DEFAULT_DRAG_STEPS = 20;
const POST_ACTION_SETTLE_MS = 3000;

const MACOS_VISION_OCR_SWIFT = `
import Vision
import AppKit
let path = CommandLine.arguments[1]
guard let nsImage = NSImage(contentsOfFile: path),
      let cgImage = nsImage.cgImage(forProposedRect: nil, context: nil, hints: nil) else { exit(2) }
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false
let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do { try handler.perform([request]) } catch { exit(3) }
let text = (request.results ?? [])
  .compactMap { $0.topCandidates(1).first?.string }
  .joined(separator: " ")
print(text)
`;

export async function macOSVisionOcr(pngBuffer) {
  if (process.platform !== "darwin") {
    throw new Error("macOSVisionOcr is only available on macOS; pass a custom ocr(buffer) instead");
  }
  const dir = mkdtempSync(path.join(tmpdir(), "omowright-ocr-"));
  try {
    const imagePath = path.join(dir, "region.png");
    const scriptPath = path.join(dir, "ocr.swift");
    writeFileSync(imagePath, pngBuffer);
    writeFileSync(scriptPath, MACOS_VISION_OCR_SWIFT);
    return await new Promise((resolve, reject) => {
      const child = spawn("swift", [scriptPath, imagePath], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", code => {
        if (code === 0) {
          const text = stdout.trim();
          resolve(text.length > 0 ? text : null);
        } else {
          reject(new Error(`Vision OCR failed (exit ${code}): ${stderr.trim()}`));
        }
      });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function createCaptcha(page, options = {}) {
  const ocr = options.ocr ?? macOSVisionOcr;

  function centerOf(bounds) {
    return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  }

  async function settleAndSnapshot(settleMs) {
    await new Promise(resolve => setTimeout(resolve, settleMs));
    return compactSnapshot(await page.snapshot());
  }

  return {
    page,

    async click(bounds, opts = {}) {
      const point = centerOf(bounds);
      await page.mouse.click(point.x, point.y);
      return settleAndSnapshot(opts.settleMs ?? POST_ACTION_SETTLE_MS);
    },

    async drag(from, to, opts = {}) {
      const steps = opts.steps ?? DEFAULT_DRAG_STEPS;
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      try {
        await page.mouse.move(to.x, to.y, { steps });
      } finally {
        await page.mouse.up();
      }
      return settleAndSnapshot(opts.settleMs ?? POST_ACTION_SETTLE_MS);
    },

    async readText(bounds) {
      const buffer = await page.screenshot(bounds ? { type: "png", clip: bounds } : { type: "png" });
      return ocr(buffer);
    },
  };
}
