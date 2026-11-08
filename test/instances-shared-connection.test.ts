// Contract owner: one approved CDP connection per browser per process, for both
// attach paths: connectNamed (#68) and connect(url) (#76).
// Chrome asks the user to allow remote debugging once per WebSocket connection
// to their own profile, so every extra upgrade is an extra prompt. The fake
// endpoint below counts upgrades at the real HTTP/WebSocket attach boundary.
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { connect } from "../src/connection.ts";
import type { BrowserConnection, ConnectOptions } from "../src/connection.ts";
import type { CdpEventMeta, CdpTransportEvents } from "../src/cdp-protocol.ts";
import { connectNamed } from "../src/instances.ts";
import { readProperty } from "../src/read-property.ts";
import * as sharedConnections from "../src/shared-connections.ts";

interface DialogAnswer {
  socket: number | undefined;
  accept: unknown;
}

function portOf(server: Server) {
  const address = server.address();
  assert.ok(address !== null && typeof address === "object", "the server is not listening on a TCP port");
  return address.port;
}

// A browser that answers discovery with its current GUID and, like Chrome,
// only upgrades the WebSocket path of that GUID.
async function fakeCdpEndpoint() {
  let guid = "first";
  const upgrades: string[] = [];
  const authorizations: Array<string | null> = [];
  const sockets = new Set<WebSocket>();
  // Each socket's id is its upgrade order; answers records how every socket
  // answered the dialogs emitDialog() raised on it.
  const socketIds = new Map<WebSocket, number>();
  const answers: DialogAnswer[] = [];
  const answered = new EventEmitter();
  const server = createServer((request, response) => {
    const body =
      request.url === "/json/version"
        ? { Browser: "FakeChrome/1.0", webSocketDebuggerUrl: webSocketUrl() }
        : request.url === "/json/list"
          ? []
          : null;
    if (!body) return void response.writeHead(404).end();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  const webSockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    if (request.url !== `/devtools/browser/${guid}`) {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      return;
    }
    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      socketIds.set(webSocket, upgrades.length);
      upgrades.push(guid);
      authorizations.push(request.headers.authorization ?? null);
      sockets.add(webSocket);
      webSocket.on("close", () => sockets.delete(webSocket));
      webSocket.on("message", (data) => {
        const { id, method, params } = JSON.parse(data.toString());
        if (method === "Page.handleJavaScriptDialog") {
          answers.push({ socket: socketIds.get(webSocket), accept: params.accept });
          answered.emit("answer");
        }
        webSocket.send(JSON.stringify({ id, result: {} }));
      });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const endpoint = `http://127.0.0.1:${portOf(server)}`;
  function webSocketUrl() {
    return `${endpoint.replace(/^http/, "ws")}/devtools/browser/${guid}`;
  }
  return {
    endpoint,
    upgrades,
    authorizations,
    sockets,
    answers,
    webSocketUrl,
    // One CDP event pushed down every open socket.
    emitEvent(method: string, params: object = {}) {
      for (const webSocket of sockets) webSocket.send(JSON.stringify({ method, params }));
    },
    // One confirm() on every open socket; resolves once each has answered.
    async dialogOnEverySocket() {
      const expected = answers.length + sockets.size;
      const done = new Promise<DialogAnswer[]>((resolve) => {
        const check = () => {
          if (answers.length < expected) return;
          answered.off("answer", check);
          resolve(answers.slice(expected - sockets.size));
        };
        answered.on("answer", check);
      });
      for (const webSocket of sockets) {
        webSocket.send(
          JSON.stringify({
            method: "Page.javascriptDialogOpening",
            sessionId: "dialog-session",
            params: { type: "confirm", message: "Leave?", url: "about:blank" },
          }),
        );
      }
      return done;
    },
    // The browser behind the port is now another one. Open sockets are kept,
    // so a stale cached connection is still alive when the lookup happens.
    becomeBrowser(nextGuid: string) {
      guid = nextGuid;
    },
    dropConnections() {
      for (const webSocket of sockets) webSocket.terminate();
    },
    async close() {
      for (const webSocket of sockets) webSocket.terminate();
      webSockets.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

type FakeEndpoint = Awaited<ReturnType<typeof fakeCdpEndpoint>>;
interface AttachContext {
  fake: FakeEndpoint;
  registryRoot: string;
}
interface AttachPath {
  label: string;
  attach(context: AttachContext, options?: ConnectOptions): Promise<BrowserConnection>;
  browserChanged(context: AttachContext): Promise<void>;
}
interface BrowserRun extends AttachContext {
  attach(options?: ConnectOptions): Promise<BrowserConnection>;
  browserChanged(): Promise<void>;
}
interface HolderRun {
  fake: FakeEndpoint;
  connectAs(options?: ConnectOptions): Promise<BrowserConnection>;
}
interface HolderCase {
  label: string;
  run(context: HolderRun): Promise<void>;
}

async function register(registryRoot: string, name: string, fake: FakeEndpoint) {
  await mkdir(registryRoot, { recursive: true, mode: 0o700 });
  const record = {
    version: 2,
    name,
    // This process stands in for the browser pid: alive for the whole test.
    pid: process.pid,
    endpoint: fake.endpoint,
    webSocketDebuggerUrl: fake.webSocketUrl(),
    profileDir: null,
    browserPath: process.execPath,
    startedAt: new Date().toISOString(),
  };
  await writeFile(path.join(registryRoot, `${name}.json`), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

// Every connected handle carries transport events; CdpTransport declares them optional.
function transportEventsOf(connection: BrowserConnection): CdpTransportEvents {
  const events = connection.cdp.transportEvents;
  assert.ok(events, "handle exposes no transportEvents");
  return events;
}

// Calls a method the handle has at runtime but CdpTransport does not declare.
function callUndeclared(target: object, name: string, ...args: unknown[]): unknown {
  const method: unknown = Reflect.get(target, name);
  assert.ok(typeof method === "function", `${name} is not a method`);
  return Reflect.apply(method, target, args);
}

function objectField(value: unknown, key: string): object {
  const found = readProperty(value, key);
  assert.ok(typeof found === "object" && found !== null, `${key} is not an object`);
  return found;
}

function nextTransportEvent(connection: BrowserConnection, name: string) {
  return new Promise<void>((resolve) => {
    const off = transportEventsOf(connection).on(name, () => {
      off();
      resolve();
    });
  });
}

// Both attach paths run every case below. A named attach finds the browser
// through its registry record (re-registered when the browser changes); a URL
// attach finds it through the endpoint's /json/version.
const namedAttach: AttachPath = {
  label: "connectNamed",
  attach: ({ registryRoot }, options = {}) => connectNamed("mine", { registryRoot, ...options }),
  browserChanged: ({ registryRoot, fake }) => register(registryRoot, "mine", fake),
};
const urlAttach: AttachPath = {
  label: "connect(url)",
  attach: ({ fake }, options) => connect(fake.endpoint, options),
  browserChanged: async () => {},
};
const attachPaths = [namedAttach, urlAttach];

async function withFakeBrowser(attachPath: AttachPath, run: (context: BrowserRun) => Promise<void>) {
  const registryRoot = await mkdtemp(path.join(tmpdir(), "omowright-shared-"));
  const fake = await fakeCdpEndpoint();
  const connections: BrowserConnection[] = [];
  const context = { fake, registryRoot };
  const attach = async (options?: ConnectOptions) => {
    const connection = await attachPath.attach(context, options);
    connections.push(connection);
    return connection;
  };
  try {
    await register(registryRoot, "mine", fake);
    await run({ ...context, attach, browserChanged: () => attachPath.browserChanged(context) });
  } finally {
    await Promise.all(connections.map((c) => c.close().catch(() => {})));
    await fake.close();
    await rm(registryRoot, { recursive: true, force: true });
  }
}

for (const attachPath of attachPaths) {
  test(`repeated ${attachPath.label} calls reuse one connection until the last close`, async () => {
    await withFakeBrowser(attachPath, async ({ fake, attach }) => {
      const first = await attach();
      const second = await attach();
      const third = await attach();
      assert.deepEqual(fake.upgrades, ["first"]);

      // A caller's close releases its handle; the others keep the connection.
      await first.close();
      await second.close();
      await third.cdp.send("Browser.getVersion");
      assert.equal(fake.sockets.size, 1);

      // The last release disconnects, so a script that closes can still exit.
      const [socket] = fake.sockets;
      assert.ok(socket, "no socket is open");
      const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()));
      await third.close();
      await closed;
      assert.deepEqual(fake.upgrades, ["first"]);
    });
  });

  test(`concurrent first ${attachPath.label} calls share one upgrade`, async () => {
    await withFakeBrowser(attachPath, async ({ fake, attach }) => {
      await Promise.all([attach(), attach(), attach()]);
      assert.deepEqual(fake.upgrades, ["first"]);
    });
  });

  test(`a dropped ${attachPath.label} connection is replaced by exactly one new upgrade`, async () => {
    await withFakeBrowser(attachPath, async ({ fake, attach }) => {
      const first = await attach();
      const dropped = nextTransportEvent(first, "disconnected");
      const restored = nextTransportEvent(first, "reconnected");
      fake.dropConnections();
      await dropped;

      const next = await attach();
      await restored;
      await next.cdp.send("Browser.getVersion");
      await first.cdp.send("Browser.getVersion");
      assert.deepEqual(fake.upgrades, ["first", "first"]);
    });
  });

  test(`${attachPath.label} never reuses a connection for a different browser GUID at the same port`, async () => {
    await withFakeBrowser(attachPath, async ({ fake, attach, browserChanged }) => {
      const old = await attach();
      fake.becomeBrowser("second");
      await browserChanged();

      const fresh = await attach();
      assert.notEqual(fresh.cdp, old.cdp);
      await fresh.cdp.send("Browser.getVersion");
      assert.deepEqual(fake.upgrades, ["first", "second"]);
    });
  });
}

// connect(url) leases are keyed by the browser GUID, so the connection behind a
// key must never end up serving another browser (#79 review). Short reconnect
// delays keep the doomed reconnects to the vanished GUID quick.
test("connect(url) never leases a connection that would serve a different browser", async () => {
  await withFakeBrowser(urlAttach, async ({ fake }) => {
    const options = { client: { reconnectDelaysMs: [0, 50] } };
    const oldUrl = fake.webSocketUrl();
    const first = await connect(fake.endpoint, options);
    let stale: BrowserConnection | undefined;
    let fresh: BrowserConnection | undefined;
    try {
      const dropped = nextTransportEvent(first, "disconnected");
      fake.becomeBrowser("second");
      fake.dropConnections();
      await dropped;

      const error = await connect(oldUrl, options).then(
        (attached) => {
          stale = attached;
          return null;
        },
        (rejection) => rejection,
      );
      assert.ok(error instanceof Error, "an attach to the vanished browser must fail, not lease");
      assert.deepEqual(fake.upgrades, ["first"]);

      // The failed entry is evicted, so the endpoint resolves anew.
      fresh = await connect(fake.endpoint, options);
      await fresh.cdp.send("Browser.getVersion");
      assert.deepEqual(fake.upgrades, ["first", "second"]);
    } finally {
      await Promise.all([first, stale, fresh].map((c) => c?.close().catch(() => {})));
    }
  });
});

// Security contract (#79 review): an authorizer is a credential, and two of them
// can hide different tokens behind equal-looking objects. Each caller gets its
// own connection, authorized with its own token.
test("connect(url) never shares one connection across two authorizers", async () => {
  class TokenAuthorizer {
    #token: string;
    constructor(token: string) {
      this.#token = token;
    }
    async resolveAuthorization() {
      return `Bearer ${this.#token}`;
    }
  }
  await withFakeBrowser(urlAttach, async ({ fake }) => {
    const a = await connect(fake.endpoint, { client: { authorizer: new TokenAuthorizer("thread-a") } });
    const b = await connect(fake.endpoint, { client: { authorizer: new TokenAuthorizer("thread-b") } });
    try {
      assert.notEqual(a.cdp, b.cdp);
      assert.deepEqual(fake.authorizations, ["Bearer thread-a", "Bearer thread-b"]);
    } finally {
      await Promise.all([a, b].map((c) => c.close().catch(() => {})));
    }
  });
});

// Contract owner: a handle never changes what another holder gets (#72 review).
// The shared connection's dialog policy, client, properties and listeners are
// what every other holder and every later attach sees. Socket 0 is the first
// connection in every row; dialogs are raised on every open socket.
type DialogPolicyArgument = Parameters<BrowserConnection["setDialogPolicy"]>[0];
const sharedPolicyPaths = [
  {
    label: "the handle",
    set: (handle: BrowserConnection, policy: DialogPolicyArgument) => handle.setDialogPolicy(policy),
  },
  {
    label: "the handle's cdp",
    set: (handle: BrowserConnection, policy: DialogPolicyArgument) => {
      const { cdp } = handle;
      assert.ok(cdp.setDialogPolicy, "handle cdp has no setDialogPolicy");
      cdp.setDialogPolicy(policy);
    },
  },
];
const byDialogSocket = (answers: DialogAnswer[]) =>
  answers.toSorted((x, y) => Number(x.socket) - Number(y.socket)).map((a) => a.accept);
const holderCases: HolderCase[] = [
  ...sharedPolicyPaths.map((policyPath): HolderCase => ({
    label: `setDialogPolicy through ${policyPath.label} on a shared connection throws SharedConnectionError`,
    async run({ fake, connectAs }) {
      const changing = await connectAs();
      await connectAs();
      assert.throws(
        () => policyPath.set(changing, { accept: false }),
        (error) => {
          assert.equal(readProperty(error, "name"), "SharedConnectionError");
          assert.ok(error instanceof sharedConnections.SharedConnectionError);
          assert.equal(readProperty(error, "code"), "shared_connection");
          assert.match(error.message, /pass dialogPolicy to connect\(\)\/connectNamed\(\)/);
          return true;
        },
      );
      assert.deepEqual(byDialogSocket(await fake.dialogOnEverySocket()), [true]);
      assert.deepEqual(fake.upgrades, ["first"]);
    },
  })),
  ...sharedPolicyPaths.map((policyPath): HolderCase => ({
    label: `a sole holder's setDialogPolicy through ${policyPath.label} works and stops sharing`,
    async run({ fake, connectAs }) {
      const sole = await connectAs();
      policyPath.set(sole, { accept: false });
      await connectAs();
      assert.deepEqual(byDialogSocket(await fake.dialogOnEverySocket()), [false, true]);
    },
  })),
  ...sharedPolicyPaths.map((policyPath): HolderCase => ({
    label: `setDialogPolicy(undefined) through ${policyPath.label} resets to accepting dialogs`,
    async run({ fake, connectAs }) {
      const sole = await connectAs({ dialogPolicy: { accept: false } });
      policyPath.set(sole, undefined);
      assert.deepEqual(byDialogSocket(await fake.dialogOnEverySocket()), [true]);
    },
  })),
  {
    label: "attaches asking for different dialog policies never share",
    async run({ fake, connectAs }) {
      await connectAs({ dialogPolicy: { accept: false } });
      await connectAs();
      assert.deepEqual(fake.upgrades, ["first", "first"]);
      assert.deepEqual(byDialogSocket(await fake.dialogOnEverySocket()), [false, true]);
    },
  },
  {
    // #81: the shared connection keeps a snapshot of the options it was
    // attached with, not the caller's object.
    label: "mutating the attach options after connect changes neither other holders nor later attaches",
    async run({ fake, connectAs }) {
      const options = { dialogPolicy: { accept: true } };
      await connectAs(options);
      const other = await connectAs({ dialogPolicy: { accept: true } });
      options.dialogPolicy.accept = false;
      assert.deepEqual(byDialogSocket(await fake.dialogOnEverySocket()), [true]);
      // A later attach asking for what was attached shares; one asking for the
      // mutated policy gets its own connection.
      await connectAs({ dialogPolicy: { accept: true } });
      await connectAs({ dialogPolicy: { accept: false } });
      assert.deepEqual(fake.upgrades, ["first", "first"]);
      // The live policy reached through a handle can't be changed in place.
      const otherPolicy: { accept?: unknown } & object = objectField(other.cdp, "dialogPolicy");
      assert.throws(() => {
        otherPolicy.accept = false;
      }, TypeError);
      assert.deepEqual(byDialogSocket(await fake.dialogOnEverySocket()), [true, false]);
    },
  },
  {
    // #81 review: with no dialogPolicy passed, the connection's default policy
    // is frozen too, so a holder can't change it for the others in place.
    label: "the default dialog policy cannot be changed in place through a handle",
    async run({ fake, connectAs }) {
      const mutating = await connectAs();
      const other = await connectAs();
      const mutatingPolicy: { accept?: unknown } & object = objectField(mutating.cdp, "dialogPolicy");
      assert.throws(() => {
        mutatingPolicy.accept = false;
      }, TypeError);
      assert.equal(readProperty(objectField(other.cdp, "dialogPolicy"), "accept"), true);
      assert.deepEqual(fake.upgrades, ["first"]);
      assert.deepEqual(byDialogSocket(await fake.dialogOnEverySocket()), [true]);
    },
  },
  {
    // #82: an unsubscribe also drops the handle's record of it, so a handle
    // that subscribes and unsubscribes N times tracks nothing afterwards. A
    // record left behind would run again on clearListeners() or close() and
    // remove the same function another holder registered since.
    label: "a handle that subscribes and unsubscribes keeps nothing to remove later",
    async run({ fake, connectAs }) {
      const churning = await connectAs();
      const other = await connectAs();
      const heard: string[] = [];
      const listener = () => heard.push("other");
      for (let i = 0; i < 50; i += 1) {
        transportEventsOf(churning).on("disconnected", listener)();
        churning.cdp.on("Target.targetCreated", listener)();
      }
      transportEventsOf(other).on("disconnected", listener);
      callUndeclared(transportEventsOf(churning), "clearListeners");
      await churning.close();
      const dropped = nextTransportEvent(other, "disconnected");
      fake.dropConnections();
      await dropped;
      assert.deepEqual(heard, ["other"]);
    },
  },
  // #140: each handle's registration is its own entry, even for one function,
  // so one holder unsubscribing or closing never removes another holder's.
  ...[
    { how: "unsubscribes", remove: (_handle: BrowserConnection, unsubscribe: () => void) => unsubscribe() },
    { how: "closes", remove: (handle: BrowserConnection) => handle.close() },
  ].map(({ how, remove }): HolderCase => ({
    label: `a handle that ${how} leaves another handle's registration of the same transport listener`,
    async run({ fake, connectAs }) {
      const removing = await connectAs();
      const other = await connectAs();
      const heard: string[] = [];
      const listener = () => heard.push("heard");
      const unsubscribe = transportEventsOf(removing).on("disconnected", listener);
      transportEventsOf(other).on("disconnected", listener);
      await remove(removing, unsubscribe);
      const dropped = nextTransportEvent(other, "disconnected");
      fake.dropConnections();
      await dropped;
      assert.deepEqual(heard, ["heard"]);
    },
  })),
  {
    // #147: a listener that answers replaces the shared policy for that dialog only; once its
    // handle closes, the listener is gone and the policy answers again. One answer per dialog.
    label: "a dialog listener added through a handle answers instead of the policy until that handle closes",
    async run({ fake, connectAs }) {
      const listening = await connectAs();
      await connectAs();
      const answered: unknown[] = [];
      // The dialog handle rides on the event meta, which CdpEventMeta does not declare.
      listening.cdp.on("Page.javascriptDialogOpening", (_params: unknown, meta: CdpEventMeta) => {
        const dialog = readProperty(meta, "dialog");
        const dismiss = readProperty(dialog, "dismiss");
        assert.ok(typeof dismiss === "function", "the dialog event meta carries no dismiss()");
        answered.push(Reflect.apply(dismiss, dialog, []));
      });
      assert.deepEqual(byDialogSocket(await fake.dialogOnEverySocket()), [false]);
      await Promise.all(answered);
      await listening.close();
      assert.deepEqual(byDialogSocket(await fake.dialogOnEverySocket()), [true]);
      assert.deepEqual(
        fake.answers.map((a) => a.accept),
        [false, true],
      );
    },
  },
  {
    label: "a property set or defined on a handle stays on that handle",
    async run({ connectAs }) {
      // A handle accepts properties its type does not declare; these views write and read them as written.
      const writer: { marker?: unknown; defined?: unknown } & object = await connectAs();
      const other: { marker?: unknown; defined?: unknown } & object = await connectAs();
      writer.marker = "set";
      Object.defineProperty(writer, "defined", { value: "defined", configurable: true });
      assert.equal(writer.marker, "set");
      assert.equal(writer.defined, "defined");
      assert.equal(other.marker, undefined);
      assert.equal(other.defined, undefined);
    },
  },
  {
    label: "a handle cannot delete a shared property",
    async run({ connectAs }) {
      const deleting: { tabs?: unknown } & object = await connectAs();
      const other = await connectAs();
      assert.throws(() => {
        delete deleting.tabs;
      }, TypeError);
      assert.deepEqual(await other.listTargets(), []);
    },
  },
  {
    label: "a client reference taken through a handle cannot change the shared client",
    async run({ fake, connectAs }) {
      const client: { logId?: unknown } & object = (await connectAs()).cdp;
      const other = await connectAs();
      const before = readProperty(other.cdp, "logId");
      assert.throws(() => {
        client.logId = "changed";
      }, TypeError);
      assert.throws(() => Object.defineProperty(client, "logId", { value: "changed" }), TypeError);
      assert.throws(() => {
        delete client.logId;
      }, TypeError);
      assert.equal(readProperty(other.cdp, "logId"), before);
      await other.cdp.send("Browser.getVersion");
      assert.deepEqual(fake.upgrades, ["first"]);
    },
  },
  {
    label: "listeners added through a handle stop when that handle closes",
    async run({ fake, connectAs }) {
      const closing = await connectAs();
      const other = await connectAs();
      const heardByClosed: string[] = [];
      closing.cdp.on("Target.targetCreated", () => heardByClosed.push("cdp"));
      transportEventsOf(closing).on("disconnected", () => heardByClosed.push("transport"));
      await closing.close();
      const delivered = new Promise<void>((resolve) => other.cdp.on("Target.targetCreated", () => resolve()));
      const dropped = nextTransportEvent(other, "disconnected");
      fake.emitEvent("Target.targetCreated", { targetInfo: { targetId: "t", type: "page" } });
      await delivered;
      fake.dropConnections();
      await dropped;
      assert.deepEqual(heardByClosed, []);
    },
  },
  {
    label: "cdp.close() on a handle releases only that handle",
    async run({ fake, connectAs }) {
      const closing = await connectAs();
      const other = await connectAs();
      await closing.cdp.close();
      await other.cdp.send("Browser.getVersion");
      assert.deepEqual(fake.upgrades, ["first"]);
      assert.equal(fake.sockets.size, 1);
    },
  },
  {
    label: "a closed handle refuses further use",
    async run({ fake, connectAs }) {
      const closed = await connectAs();
      await connectAs();
      await closed.close();
      assert.throws(() => closed.listTargets(), /handle was closed/);
      assert.throws(() => closed.cdp, /handle was closed/);
      assert.deepEqual(fake.upgrades, ["first"]);
    },
  },
  {
    label: "clearListeners through a handle removes only that handle's transport listeners",
    async run({ fake, connectAs }) {
      const clearing = await connectAs();
      const other = await connectAs();
      const heard: string[] = [];
      transportEventsOf(clearing).on("disconnected", () => heard.push("clearing"));
      transportEventsOf(other).on("disconnected", () => heard.push("other"));
      callUndeclared(transportEventsOf(clearing), "clearListeners");
      const dropped = nextTransportEvent(other, "disconnected");
      fake.dropConnections();
      await dropped;
      assert.deepEqual(heard, ["other"]);
    },
  },
  {
    label: "emit through a handle is refused",
    async run({ connectAs }) {
      const emitting = await connectAs();
      const other = await connectAs();
      const heard: string[] = [];
      transportEventsOf(other).on("disconnected", () => heard.push("other"));
      assert.throws(() => callUndeclared(transportEventsOf(emitting), "emit", "disconnected"), TypeError);
      assert.deepEqual(heard, []);
    },
  },
  {
    label: "a handle's reserved members cannot be replaced",
    async run({ connectAs }) {
      const handle: { cdp?: unknown; close?: unknown; setDialogPolicy?: unknown } & object = await connectAs();
      for (const member of ["cdp", "close", "setDialogPolicy"] as const) {
        assert.throws(
          () => {
            handle[member] = () => {};
          },
          TypeError,
          member,
        );
        assert.throws(() => Object.defineProperty(handle, member, { value: 1, configurable: true }), TypeError, member);
      }
    },
  },
  {
    label: "a handle's own keys and descriptors show what was set on it",
    async run({ connectAs }) {
      const writer: { marker?: unknown } & object = await connectAs();
      const other = await connectAs();
      writer.marker = "set";
      assert.ok(Object.keys(writer).includes("marker"));
      assert.equal(Object.getOwnPropertyDescriptor(writer, "marker")?.value, "set");
      assert.ok(!Object.keys(other).includes("marker"));
      assert.equal(Object.getOwnPropertyDescriptor(other, "marker"), undefined);
    },
  },
];

for (const attachPath of attachPaths) {
  for (const holderCase of holderCases) {
    test(`${attachPath.label}: ${holderCase.label}`, async () => {
      await withFakeBrowser(attachPath, ({ fake, attach }) =>
        holderCase.run({ fake, connectAs: (options) => attach(options) }),
      );
    });
  }
}

// Options are shared only when equality can see all of them (#79 review): a
// cycle must not throw, and a symbol or non-enumerable key, or an accessor, can
// hide a difference (a non-enumerable dialogPolicy is still read when the
// connection is made), so each of these gets a connection of its own.
const unshareableOptions = [
  {
    label: "cyclic options",
    make: () => {
      const options: { client: { owner?: unknown } } = { client: {} };
      options.client.owner = options;
      return options;
    },
  },
  {
    label: "a non-enumerable dialogPolicy",
    make: () => Object.defineProperty({}, "dialogPolicy", { value: { accept: false }, enumerable: false }),
  },
  { label: "a symbol key", make: () => ({ [Symbol.for("omowright.test")]: true }) },
  {
    label: "an accessor",
    make: () => ({
      get storageRoot() {
        return ".";
      },
    }),
  },
];
for (const unshareable of unshareableOptions) {
  test(`connect(url) with ${unshareable.label} gets a connection of its own`, async () => {
    await withFakeBrowser(urlAttach, async ({ fake }) => {
      const handles: BrowserConnection[] = [];
      try {
        handles.push(await connect(fake.endpoint, unshareable.make()));
        handles.push(await connect(fake.endpoint, unshareable.make()));
        assert.notEqual(handles[0]?.cdp, handles[1]?.cdp);
        assert.deepEqual(fake.upgrades, ["first", "first"]);
      } finally {
        await Promise.all(handles.map((h) => h.close().catch(() => {})));
      }
    });
  });
}
