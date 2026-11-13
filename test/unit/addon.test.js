import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { ADDON_ID, ADDON_VERSION, addonInfo, addonState, buildXpi, compareVersions, connectControl, crc32, sideloadAddon, zip } from "../../src/addon.js";

const pkg = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

test("the add-on has a valid id and version", () => {
  // Versioned on its own: bump it only when extension/ changes, since an
  // update restarts the add-on in the user's browser.
  assert.match(ADDON_VERSION, /^\d+\.\d+\.\d+$/);
  assert.ok(compareVersions(ADDON_VERSION, pkg.version) <= 0);
  assert.equal(ADDON_ID, "claude-for-zen@ilhamnadhif.github.io");
});

test("crc32 matches zlib", () => {
  const data = Buffer.from("claude-for-zen ✓ \u{1F44B}");
  if (zlib.crc32) assert.equal(crc32(data), zlib.crc32(data));
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
});

/** Read back a stored (uncompressed) zip. */
function unzipStored(buf) {
  const files = {};
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString();
    assert.equal(buf.readUInt32LE(offset), 0x04034b50);
    const dataStart = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    const data = buf.subarray(dataStart, dataStart + size);
    assert.equal(crc32(data), crc);
    files[name] = data;
    p += 46 + nameLen;
  }
  return files;
}

test("buildXpi packages the extension as a valid zip", () => {
  const files = unzipStored(buildXpi());
  assert.deepEqual(Object.keys(files).sort(), ["manifest.json", "parent.js", "schema.json"]);
  const manifest = JSON.parse(files["manifest.json"]);
  assert.equal(manifest.browser_specific_settings.gecko.id, ADDON_ID);
  assert.ok(manifest.experiment_apis.claudeForZen.parent.events.includes("startup"));
  const z = zip([{ name: "a.txt", data: Buffer.from("hello") }]);
  assert.equal(unzipStored(z)["a.txt"].toString(), "hello");
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfz-xpi-"));
    fs.writeFileSync(path.join(dir, "a.xpi"), buildXpi());
    execFileSync("unzip", ["-t", path.join(dir, "a.xpi")], { stdio: "ignore" }); // independent check when unzip exists
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
});

test("compareVersions", () => {
  assert.ok(compareVersions("1.3.0", "1.2.9") > 0);
  assert.equal(compareVersions("1.3", "1.3.0"), 0);
  assert.ok(compareVersions("1.10.0", "1.9.0") > 0);
  assert.ok(compareVersions(undefined, "0.0.1") < 0);
});

test("addonState / addonInfo / sideloadAddon read and write the profile", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfz-addon-"));
  assert.equal(addonState(dir), null);
  fs.writeFileSync(path.join(dir, "claude-for-zen.json"), JSON.stringify({ port: 1234, token: "x".repeat(64), pid: 42, version: "1.3.0" }));
  assert.equal(addonState(dir).port, 1234);
  fs.writeFileSync(path.join(dir, "claude-for-zen.json"), JSON.stringify({ port: "nope", token: "short" }));
  assert.equal(addonState(dir), null);

  assert.equal(addonInfo(dir), null);
  assert.equal(sideloadAddon(dir), true);
  assert.ok(fs.existsSync(path.join(dir, "extensions", `${ADDON_ID}.xpi`)));
  assert.equal(sideloadAddon(dir), false, "an existing copy is left alone");
  fs.writeFileSync(path.join(dir, "extensions.json"), JSON.stringify({ addons: [{ id: ADDON_ID, version: "1.0.0", active: true, userDisabled: false }] }));
  assert.deepEqual(addonInfo(dir), { version: "1.0.0", active: true, userDisabled: false });
  assert.equal(sideloadAddon(dir), true, "an older version is replaced");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("connectControl talks the add-on's JSON-line protocol", async () => {
  const token = "t".repeat(64);
  const seen = [];
  let closedByClient;
  const closed = new Promise((r) => (closedByClient = r));
  const server = net.createServer((sock) => {
    let buf = "";
    sock.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        seen.push(msg);
        if (msg.token !== token) sock.end(JSON.stringify({ ok: false, error: "invalid token" }) + "\n");
        else if (msg.cmd === "start") sock.write(JSON.stringify({ ok: true, port: 9222 }) + "\n");
        else sock.write(JSON.stringify({ ok: false, error: "nope" }) + "\n");
      }
    });
    sock.on("close", () => closedByClient());
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const state = { port: server.address().port, token };
  const c = await connectControl(state);
  assert.equal(await c.start(), 9222);
  await assert.rejects(c.request("bogus").then((r) => { if (!r.ok) throw new Error(r.error); }), /nope/);
  c.close();
  await closed; // closing the connection is what tells the add-on to switch remote control off
  assert.deepEqual(seen.map((m) => m.cmd), ["start", "bogus"]);

  const bad = await connectControl({ ...state, token: "w".repeat(64) });
  await assert.rejects(bad.start(), /invalid token/);
  bad.close();
  server.close();
  await assert.rejects(connectControl(state, { timeoutMs: 500 }), /could not reach|did not accept/);
});
