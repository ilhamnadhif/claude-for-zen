import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket, { WebSocketServer } from "ws";
import { startBroker } from "../../src/broker.js";

/** A stand-in for Zen's WebDriver BiDi endpoint. */
async function fakeBrowser() {
  const calls = [];
  const sockets = new Set();
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  server.on("connection", (ws) => {
    sockets.add(ws);
    ws.on("message", (d) => {
      const { id, method, params } = JSON.parse(d);
      calls.push(method);
      if (method === "session.new") ws.send(JSON.stringify({ type: "success", id, result: { sessionId: "s1", capabilities: { browserName: "fake" } } }));
      else if (method === "script.addPreloadScript") ws.send(JSON.stringify({ type: "success", id, result: { script: `p${calls.length}` } }));
      else if (method === "fail.me") ws.send(JSON.stringify({ type: "error", id, error: "unknown command", message: "nope" }));
      else setTimeout(() => ws.send(JSON.stringify({ type: "success", id, result: { echo: method, params } })), method === "slow" ? 80 : 0);
    });
  });
  await new Promise((r) => server.once("listening", r));
  return {
    url: `ws://127.0.0.1:${server.address().port}/session`,
    calls,
    emit: (event) => sockets.forEach((ws) => ws.send(JSON.stringify({ type: "event", ...event }))),
    // Like a browser quitting: drop the connections, then stop listening.
    close: () => {
      sockets.forEach((ws) => ws.terminate());
      return new Promise((r) => server.close(r));
    },
  };
}

async function client(url) {
  const ws = new WebSocket(url);
  await new Promise((r, j) => {
    ws.once("open", r);
    ws.once("error", j);
  });
  const events = [];
  const waiting = new Map();
  ws.on("message", (d) => {
    const m = JSON.parse(d);
    if (m.type === "event") events.push(m);
    else waiting.get(m.id)?.(m);
  });
  return {
    ws,
    events,
    send: (id, method, params = {}) =>
      new Promise((r) => {
        waiting.set(id, r);
        ws.send(JSON.stringify({ id, method, params }));
      }),
  };
}

test("the broker shares one session between clients", async () => {
  const browser = await fakeBrowser();
  let exited = null;
  const exitedP = new Promise((r) => (exited = r));
  const broker = await startBroker({ upstreamUrl: browser.url, idleMs: 150, onExit: exited });
  const url = `ws://127.0.0.1:${broker.port}/?token=${broker.token}`;

  await assert.rejects(client(`ws://127.0.0.1:${broker.port}/?token=wrong`), "a wrong token is refused");

  const a = await client(url);
  const b = await client(url);
  const [sa, sb] = await Promise.all([a.send(1, "session.new"), b.send(1, "session.new")]);
  assert.equal(sa.result.sessionId, "s1");
  assert.equal(sb.result.sessionId, "s1");
  assert.equal(browser.calls.filter((c) => c === "session.new").length, 1, "one real session");

  // Same ids from different clients don't get mixed up.
  const [ra, rb] = await Promise.all([a.send(7, "slow", { who: "a" }), b.send(7, "fast", { who: "b" })]);
  assert.deepEqual([ra.id, ra.result.echo, ra.result.params.who], [7, "slow", "a"]);
  assert.deepEqual([rb.id, rb.result.echo, rb.result.params.who], [7, "fast", "b"]);
  const err = await a.send(8, "fail.me");
  assert.equal(err.type, "error");
  assert.equal(err.id, 8);

  // Every client sees every event.
  browser.emit({ method: "log.entryAdded", params: { text: "hi" } });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(a.events.length, 1);
  assert.equal(b.events.length, 1);

  // Identical preload scripts are added once.
  const p1 = await a.send(9, "script.addPreloadScript", { functionDeclaration: "() => 1" });
  const p2 = await b.send(9, "script.addPreloadScript", { functionDeclaration: "() => 1" });
  assert.equal(p1.result.script, p2.result.script);
  assert.equal(browser.calls.filter((c) => c === "script.addPreloadScript").length, 1);

  // session.end only detaches the client while others remain.
  const end = await a.send(10, "session.end");
  assert.equal(end.result["cfz:otherClients"], 1);
  assert.equal(browser.calls.includes("session.end"), false);
  a.ws.close();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(broker.clients(), 1);
  assert.equal(browser.calls.includes("session.end"), false, "still in use by b");

  // The last client leaving ends the real session and stops the broker.
  b.ws.close();
  assert.equal(await exitedP, "no clients left");
  assert.equal(browser.calls.filter((c) => c === "session.end").length, 1);
  await browser.close();
});

test("the broker stops when the browser goes away", async () => {
  const browser = await fakeBrowser();
  let exited;
  const exitedP = new Promise((r) => (exited = r));
  const broker = await startBroker({ upstreamUrl: browser.url, onExit: exited });
  const c = await client(`ws://127.0.0.1:${broker.port}/?token=${broker.token}`);
  const closed = new Promise((r) => c.ws.once("close", r));
  await browser.close();
  assert.equal(await exitedP, "browser connection closed");
  await closed; // clients are disconnected too, so they reconnect through a new broker
});
