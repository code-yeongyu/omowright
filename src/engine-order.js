/**
 * The one ranked list of browser engines.
 *
 * User order (2026-11-08): aside / egolight integration > local browser through
 * BrowserSkill (`bsk`) > omowright's own CloakBrowser profile. The order lives
 * here and nowhere else: `assertEngineChoice` refuses a lower tier until the
 * caller names a FALLBACK_REASON that reaches it, so a new call site cannot
 * quietly start at CloakBrowser because it was the convenient import.
 *
 * egolight joins at tier 0 beside `aside` when its integration lands. It has no
 * entry yet: a registry row without a connect path would rank a browser nobody
 * can drive.
 */

export const FALLBACK_REASONS = Object.freeze({
  "aside-unavailable": Object.freeze({
    tier: 1,
    means:
      "the aside CLI is missing on this host, is signed out, or its browser cannot be reached",
  }),
  "need-raw-protocol": Object.freeze({
    tier: 1,
    means:
      "the task needs the CDP command surface (refs and snapshots, routes, request snooping, tab borrowing, MV3 APIs) that aside repl cannot express",
  }),
  "need-isolated-profile": Object.freeze({
    tier: 2,
    means:
      "the task must not touch a profile the user is signed into, so no real browser may be driven",
  }),
});

export const BROWSER_ENGINES = Object.freeze([
  Object.freeze({
    id: "aside",
    tier: 0,
    label: "Aside browser agent",
    entrypoint: "aside repl",
    useWhen:
      "every browsing task starts here: it drives the browser the user is already signed into and hands a blocked login to them",
  }),
  Object.freeze({
    id: "bsk",
    tier: 1,
    label: "Local browser through BrowserSkill",
    entrypoint: "connectBrowserSkill",
    useWhen:
      "aside cannot run on this host, or the task needs the CDP command surface listed under need-raw-protocol",
  }),
  Object.freeze({
    id: "cloakbrowser",
    tier: 2,
    label: "omowright owned profile (CloakBrowser)",
    entrypoint: "connectCloakProfile",
    useWhen:
      "nobody's signed-in browser may be touched, or no real browser is reachable from here",
  }),
]);

export class EngineOrderViolation extends Error {
  constructor(message, { engine, reason } = {}) {
    super(message);
    this.name = "EngineOrderViolation";
    this.engine = engine;
    this.reason = reason;
  }
}

export class NoBrowserEngine extends Error {
  constructor(message, { skipped } = {}) {
    super(message);
    this.name = "NoBrowserEngine";
    this.skipped = skipped ?? [];
  }
}

export function engineOrder() {
  return BROWSER_ENGINES.map((engine) => engine.id);
}

export function engineById(engineId) {
  const engine = BROWSER_ENGINES.find((candidate) => candidate.id === engineId);
  if (!engine) {
    throw new EngineOrderViolation(
      `unknown browser engine ${JSON.stringify(engineId)}; the ranked list is ${engineOrder().join(" > ")}`,
      { engine: engineId },
    );
  }
  return engine;
}

function higherThan(engine) {
  return BROWSER_ENGINES.filter((candidate) => candidate.tier < engine.tier);
}

function reasonsReaching(tier) {
  return Object.entries(FALLBACK_REASONS)
    .filter(([, reason]) => reason.tier >= tier)
    .map(([id]) => id);
}

export function assertEngineChoice(engineId, { fallbackReason } = {}) {
  const engine = engineById(engineId);
  if (engine.tier === 0) return engine;

  const above = higherThan(engine).map((candidate) => `${candidate.id} (tier ${candidate.tier})`);
  const allowed = reasonsReaching(engine.tier);

  if (fallbackReason === undefined) {
    throw new EngineOrderViolation(
      `${engineId} is tier ${engine.tier} and ${above.join(", ")} rank above it. Name a fallbackReason: ${allowed.join(", ")}`,
      { engine: engineId },
    );
  }

  const reason = FALLBACK_REASONS[fallbackReason];
  if (!reason) {
    throw new EngineOrderViolation(
      `unknown fallbackReason ${JSON.stringify(fallbackReason)}; use one of ${Object.keys(FALLBACK_REASONS).join(", ")}`,
      { engine: engineId, reason: fallbackReason },
    );
  }

  if (reason.tier < engine.tier) {
    throw new EngineOrderViolation(
      `${fallbackReason} reaches tier ${reason.tier}; ${engineId} is tier ${engine.tier}, so it cannot justify skipping ${higherThan(engine)
        .filter((candidate) => candidate.tier >= reason.tier)
        .map((candidate) => candidate.id)
        .join(", ")}. Use one of: ${allowed.join(", ")}`,
      { engine: engineId, reason: fallbackReason },
    );
  }

  return engine;
}

export function enginePlan({ fallbackReason } = {}) {
  if (fallbackReason === undefined) return [...BROWSER_ENGINES];
  const reason = FALLBACK_REASONS[fallbackReason];
  if (!reason) {
    throw new EngineOrderViolation(
      `unknown fallbackReason ${JSON.stringify(fallbackReason)}; use one of ${Object.keys(FALLBACK_REASONS).join(", ")}`,
      { reason: fallbackReason },
    );
  }
  return BROWSER_ENGINES.filter((engine) => engine.tier >= reason.tier);
}
