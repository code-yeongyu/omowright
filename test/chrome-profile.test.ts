import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ChromeProfileRowError, createProfileApis, selectRows } from "../src/chrome-profile.ts";
import { removeTreeSync } from "./fixtures/remove-tree.ts";

test("profile SQL rows retain NULL, BLOB and BigInt values", () => {
  const db = new DatabaseSync(":memory:", { readBigInts: true });
  try {
    const [row] = selectRows(db, "SELECT NULL AS nullable, x'00ff31' AS bytes, 9007199254740993 AS large");
    assert.ok(row);
    assert.equal(row["nullable"], null);
    assert.ok(row["bytes"] instanceof Uint8Array);
    assert.deepEqual(Array.from(row["bytes"]), [0, 255, 49]);
    assert.equal(row["large"], 9007199254740993n);
  } finally {
    db.close();
  }
});

test("profile history preserves integer conversion and millisecond truncation", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "omowright-profile-values-"));
  t.after(() => removeTreeSync(root));
  mkdirSync(path.join(root, "Default"));
  const db = new DatabaseSync(path.join(root, "Default", "History"));
  db.exec(`
    CREATE TABLE urls (id INTEGER, url TEXT, title TEXT, visit_count INTEGER, last_visit_time INTEGER);
    CREATE TABLE visits (id INTEGER, url INTEGER, visit_time INTEGER, transition INTEGER);
    INSERT INTO urls VALUES (9007199254740993, 'https://example.test/', NULL, 9007199254740993, 13210862400001999);
    INSERT INTO visits VALUES (9007199254740993, 9007199254740993, 13210862400001999, 1);
  `);
  db.close();
  const profile = createProfileApis(root);
  assert.deepEqual(await profile.history.search({ text: "example.test" }), [
    {
      id: "9007199254740993",
      url: "https://example.test/",
      title: "",
      visitCount: 9007199254740992,
      lastVisitTime: 1566388800001,
    },
  ]);
  assert.deepEqual(await profile.history.getVisits({ url: "https://example.test/" }), [
    {
      id: "9007199254740993",
      url: "https://example.test/",
      visitTime: 1566388800001,
      transition: 1,
    },
  ]);
});

test("profile top sites retain BLOB fields and default only nullish titles", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "omowright-profile-blobs-"));
  t.after(() => removeTreeSync(root));
  mkdirSync(path.join(root, "Default"));
  const db = new DatabaseSync(path.join(root, "Default", "Top Sites"));
  db.exec(`
    CREATE TABLE top_sites (url, title, url_rank INTEGER);
    INSERT INTO top_sites VALUES (x'00ff', NULL, 0);
    INSERT INTO top_sites VALUES (NULL, x'31', 1);
  `);
  db.close();
  const rows = await createProfileApis(root).topSites.get();
  assert.equal(rows.length, 2);
  const [first, second] = rows;
  assert.ok(first?.url instanceof Uint8Array);
  assert.deepEqual(Array.from(first.url), [0, 255]);
  assert.equal(first.title, "");
  assert.equal(second?.url, null);
  assert.ok(second?.title instanceof Uint8Array);
  assert.deepEqual(Array.from(second.title), [49]);
});

test("a NULL profile visit timestamp keeps its TypeError failure", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "omowright-profile-null-time-"));
  t.after(() => removeTreeSync(root));
  mkdirSync(path.join(root, "Default"));
  const db = new DatabaseSync(path.join(root, "Default", "History"));
  db.exec(`
    CREATE TABLE urls (id INTEGER, url TEXT);
    CREATE TABLE visits (id INTEGER, url INTEGER, visit_time, transition INTEGER);
    INSERT INTO urls VALUES (1, 'https://example.test/');
    INSERT INTO visits VALUES (1, 1, NULL, 1);
  `);
  db.close();
  await assert.rejects(
    createProfileApis(root).history.getVisits({ url: "https://example.test/" }),
    (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.ok(error instanceof ChromeProfileRowError);
      assert.equal(error.message, "Cannot convert null to a BigInt");
      return true;
    },
  );
});
