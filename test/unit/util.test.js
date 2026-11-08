import { test } from "node:test";
import assert from "node:assert/strict";
import { redactUrl, normalizeUrl, formatBytes } from "../../src/util.js";

test("redactUrl hides credentials and sensitive query values", () => {
  assert.equal(redactUrl("https://user:pw@example.com/a?token=abc&page=2"), "https://REDACTED:REDACTED@example.com/a?token=REDACTED&page=2");
  assert.equal(redactUrl("https://x.test/?api_key=1&sig=2&q=hello"), "https://x.test/?api_key=REDACTED&sig=REDACTED&q=hello");
  assert.match(redactUrl("data:text/html," + "x".repeat(200)), /…$/);
  assert.equal(redactUrl(""), "");
});

test("normalizeUrl", () => {
  assert.equal(normalizeUrl("example.com"), "https://example.com");
  assert.equal(normalizeUrl("example.com:8080/x"), "https://example.com:8080/x");
  assert.equal(normalizeUrl("localhost:3000"), "http://localhost:3000");
  assert.equal(normalizeUrl("127.0.0.1:8000/a"), "http://127.0.0.1:8000/a");
  assert.equal(normalizeUrl("192.168.1.5"), "http://192.168.1.5");
  assert.equal(normalizeUrl("myapp.localhost:5173"), "http://myapp.localhost:5173");
  assert.equal(normalizeUrl("http://a.b/c"), "http://a.b/c");
  assert.equal(normalizeUrl("about:blank"), "about:blank");
  assert.equal(normalizeUrl("data:text/html,hi"), "data:text/html,hi");
});

test("formatBytes", () => {
  assert.equal(formatBytes(0), "");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatBytes(3 * 1024 * 1024), "3.0 MB");
});
