// Contract owner: the public named-instance registry lifecycle. These tests use
// the real HTTP/WebSocket attach boundary, so stale-state, locking, or record
// regressions fail without adding a production-only seam.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";
import { connectNamed, listInstances } from "../src/instances.js";

const fixture = fileURLToPath(
  new URL("./fixtures/fake-named-browser.mjs", import.meta.url),
);

function instanceRecord(name, values) {
  return {
    version: 1,
    name,
    pid: values.pid,
    endpoint: values.endpoint,
    profileDir: values.profileDir ?? null,
    browserPath: values.browserPath ?? process.execPath,
    startedAt: values.startedAt ?? new Date().toISOString(),
  };
}

async function writeRecord(registryRoot, name, record) {
  await mkdir(registryRoot, { recursive: true, mode: 0o700 });
  const recordPath = path.join(registryRoot, `${name}.json`);
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, {
    mode: 0o600,
  });
  return recordPath;
}

async function launchFakeBrowser() {
  const child = spawn(
    process.execPath,
    [
      fixture,
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  child.stderr.setEncoding("utf8");
  let stderr = "";
  const endpoint = await new Promise((resolve, reject) => {
    const onData = (chunk) => {
      stderr += chunk;
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
      if (!match) return;
      cleanup();
      resolve(
        match[1]
          .replace(/^ws:/, "http:")
          .replace(/\/devtools\/.*$/, ""),
      );
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(
        new Error(
          `fake browser exited early (code ${code}, signal ${signal ?? "none"})`,
        ),
      );
    };
    const cleanup = () => {
      child.stderr.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    child.stderr.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
  return { child, endpoint };
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
}

function deadPid() {
  for (const pid of [2_147_483_647, 1_073_741_823, 536_870_911]) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return pid;
      if (error?.code !== "EPERM") throw error;
    }
  }
  throw new Error("could not find an unused pid for the stale-record test");
}

async function closedEndpoint() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  return endpoint;
}

test("connectNamed attaches to a healthy registered browser", async () => {
  const registryRoot = await mkdtemp(
    path.join(tmpdir(), "omowright-instances-"),
  );
  const fake = await launchFakeBrowser();
  let connection;
  try {
    await writeRecord(
      registryRoot,
      "healthy",
      instanceRecord("healthy", {
        pid: fake.child.pid,
        endpoint: fake.endpoint,
      }),
    );

    connection = await connectNamed("healthy", { registryRoot });

    assert.equal(connection.browserProcess, undefined);
    assert.deepEqual(await connection.listTargets(), [
      {
        description: "",
        id: "fake-page",
        title: "Fake named browser",
        type: "page",
        url: "about:blank",
      },
    ]);
    await connection.close();
    connection = null;
    assert.doesNotThrow(() => process.kill(fake.child.pid, 0));
  } finally {
    await connection?.close().catch(() => {});
    await stopChild(fake.child);
    await rm(registryRoot, { recursive: true, force: true });
  }
});

test("connectNamed replaces a dead-pid record with one launched browser", async () => {
  const registryRoot = await mkdtemp(
    path.join(tmpdir(), "omowright-instances-"),
  );
  const profileDir = path.join(registryRoot, "profile");
  const stalePid = deadPid();
  const recordPath = await writeRecord(
    registryRoot,
    "stale",
    instanceRecord("stale", {
      pid: stalePid,
      endpoint: "http://127.0.0.1:1",
      profileDir,
    }),
  );
  let connection;
  try {
    connection = await connectNamed("stale", {
      registryRoot,
      browserPath: process.execPath,
      browserArgs: [fixture],
      profileDir,
    });

    assert.equal(connection.browserProcess?.pid > 0, true);
    const rewritten = JSON.parse(await readFile(recordPath, "utf8"));
    assert.equal(rewritten.version, 1);
    assert.equal(rewritten.name, "stale");
    assert.equal(rewritten.pid, connection.browserProcess.pid);
    assert.notEqual(rewritten.pid, stalePid);
    assert.notEqual(rewritten.endpoint, "http://127.0.0.1:1");
    assert.equal(rewritten.profileDir, profileDir);
    assert.equal(rewritten.browserPath, process.execPath);
    assert.equal((await stat(registryRoot)).mode & 0o777, 0o700);
    assert.equal((await stat(recordPath)).mode & 0o777, 0o600);
    const launchedPid = connection.browserProcess.pid;
    await connection.close();
    connection = null;
    assert.throws(
      () => process.kill(launchedPid, 0),
      (error) => error?.code === "ESRCH",
    );
  } finally {
    await connection?.close().catch(() => {});
    await rm(registryRoot, { recursive: true, force: true });
  }
});

test("connectNamed relaunches when a reused pid leaves a refused endpoint", async () => {
  const registryRoot = await mkdtemp(
    path.join(tmpdir(), "omowright-instances-"),
  );
  const endpoint = await closedEndpoint();
  let connection;
  try {
    await writeRecord(
      registryRoot,
      "reused",
      instanceRecord("reused", { pid: process.pid, endpoint }),
    );

    connection = await connectNamed("reused", {
      registryRoot,
      browserPath: process.execPath,
      browserArgs: [fixture],
      probeTimeoutMs: 250,
    });

    // The live pid (this process) was NOT the holder: a fresh browser was
    // launched and the record rewritten to its pid.
    assert.notEqual(connection.browserProcess.pid, process.pid);
    const rewritten = JSON.parse(
      await readFile(path.join(registryRoot, "reused.json"), "utf8"),
    );
    assert.equal(rewritten.pid, connection.browserProcess.pid);
    // Registry hygiene: no lock or temp artifacts survive a completed flow.
    const leftovers = (await readdir(registryRoot)).filter(
      (name) => name.endsWith(".lock") || name.endsWith(".tmp"),
    );
    assert.deepEqual(leftovers, []);
  } finally {
    await connection?.close().catch(() => {});
    await rm(registryRoot, { recursive: true, force: true });
  }
});

test("connectNamed rejects an alive holder whose endpoint hangs", async () => {
  const registryRoot = await mkdtemp(
    path.join(tmpdir(), "omowright-instances-"),
  );
  const server = createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  try {
    await writeRecord(
      registryRoot,
      "hung",
      instanceRecord("hung", { pid: process.pid, endpoint }),
    );

    await assert.rejects(
      connectNamed("hung", { registryRoot, probeTimeoutMs: 250 }),
      (error) => {
        assert.match(error.message, /unresponsive holder/);
        assert.match(error.message, new RegExp(`pid ${process.pid}`));
        assert.match(
          error.message,
          new RegExp(endpoint.replaceAll(".", "\\.")),
        );
        return true;
      },
    );
  } finally {
    server.close();
    await rm(registryRoot, { recursive: true, force: true });
  }
});

test("connectNamed recovers from a malformed record", async () => {
  const registryRoot = await mkdtemp(
    path.join(tmpdir(), "omowright-instances-"),
  );
  const recordPath = path.join(registryRoot, "malformed.json");
  await writeFile(recordPath, "{not-json}\n", { mode: 0o600 });
  let connection;
  try {
    connection = await connectNamed("malformed", {
      registryRoot,
      browserPath: process.execPath,
      browserArgs: [fixture],
    });

    const rewritten = JSON.parse(await readFile(recordPath, "utf8"));
    assert.equal(rewritten.version, 1);
    assert.equal(rewritten.name, "malformed");
    assert.equal(rewritten.pid, connection.browserProcess.pid);
  } finally {
    await connection?.close().catch(() => {});
    await rm(registryRoot, { recursive: true, force: true });
  }
});

test("concurrent connectNamed calls launch exactly one browser", async () => {
  const registryRoot = await mkdtemp(
    path.join(tmpdir(), "omowright-instances-"),
  );
  const options = {
    registryRoot,
    browserPath: process.execPath,
    browserArgs: [fixture],
  };
  let connections = [];
  try {
    connections = await Promise.all([
      connectNamed("shared", options),
      connectNamed("shared", options),
    ]);

    const launched = connections.filter(
      (connection) => connection.browserProcess,
    );
    assert.equal(launched.length, 1);
    const record = JSON.parse(
      await readFile(path.join(registryRoot, "shared.json"), "utf8"),
    );
    assert.equal(record.pid, launched[0].browserProcess.pid);
    assert.deepEqual(
      await connections[0].listTargets(),
      await connections[1].listTargets(),
    );

    const attached = connections.find(
      (connection) => !connection.browserProcess,
    );
    await attached.close();
    connections = connections.filter((connection) => connection !== attached);
    assert.doesNotThrow(() => process.kill(record.pid, 0));
  } finally {
    await Promise.all(
      connections.map((connection) => connection.close().catch(() => {})),
    );
    await rm(registryRoot, { recursive: true, force: true });
  }
});

test("listInstances reports versioned records with liveness metadata", async () => {
  const registryRoot = await mkdtemp(
    path.join(tmpdir(), "omowright-instances-"),
  );
  const fake = await launchFakeBrowser();
  try {
    await writeRecord(
      registryRoot,
      "alive",
      instanceRecord("alive", {
        pid: fake.child.pid,
        endpoint: fake.endpoint,
      }),
    );
    await writeRecord(
      registryRoot,
      "dead",
      instanceRecord("dead", {
        pid: deadPid(),
        endpoint: "http://127.0.0.1:1",
      }),
    );
    await writeFile(path.join(registryRoot, "broken.json"), "not json\n", {
      mode: 0o600,
    });
    await chmod(path.join(registryRoot, "alive.json"), 0o644);

    const instances = await listInstances({ registryRoot });

    assert.deepEqual(
      instances.map((instance) => instance.name),
      ["alive", "dead"],
    );
    assert.deepEqual(
      Object.keys(instances[0]).sort(),
      [
        "alive",
        "browserPath",
        "endpoint",
        "name",
        "pid",
        "profileDir",
        "responsive",
        "startedAt",
        "version",
      ].sort(),
    );
    assert.equal(instances[0].alive, true);
    assert.equal(instances[0].responsive, true);
    assert.equal(instances[1].alive, false);
    assert.equal(instances[1].responsive, false);
    assert.equal(
      (await stat(path.join(registryRoot, "alive.json"))).mode & 0o777,
      0o600,
    );
  } finally {
    await stopChild(fake.child);
    await rm(registryRoot, { recursive: true, force: true });
  }
});
