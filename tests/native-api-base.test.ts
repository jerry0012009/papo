import assert from "node:assert/strict";
import { resolveNativeApiBase } from "../src/web/native-api-base";

assert.equal(
  resolveNativeApiBase("/papo-api", "https://eu.jerrypsy.top"),
  "https://eu.jerrypsy.top/papo-api"
);
assert.equal(
  resolveNativeApiBase("https://eu.jerrypsy.top/papo-api/", "https://localhost"),
  "https://eu.jerrypsy.top/papo-api"
);
assert.equal(resolveNativeApiBase("http://eu.jerrypsy.top/papo-api", "https://eu.jerrypsy.top"), "");
assert.equal(resolveNativeApiBase("javascript:alert(1)", "https://eu.jerrypsy.top"), "");
assert.equal(resolveNativeApiBase(undefined, "https://eu.jerrypsy.top"), "");

console.log(JSON.stringify({ ok: true, apiBase: "https://eu.jerrypsy.top/papo-api" }));
