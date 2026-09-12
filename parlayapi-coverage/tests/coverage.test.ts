import assert from "node:assert/strict";
import { after, test } from "node:test";
import { context } from "@opentelemetry/api";
import { isTracingSuppressed } from "@opentelemetry/core";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { checkCoverage, summarizeResponse } from "../src/coverage.js";
import { coverageTaskOptions, parlayCoverage } from "../src/trigger/coverage.js";

const now = Date.parse("2030-01-01T00:00:00Z");
const options = { sport: "soccer_epl", bookmaker: "pinnacle", expectedOutcomes: 3 as const, maxAgeSeconds: 300 };
const originalFetch = globalThis.fetch;
const originalKey = process.env.PARLAY_API_KEY;
const manager = new AsyncLocalStorageContextManager().enable();
context.setGlobalContextManager(manager);
after(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.PARLAY_API_KEY;
  else process.env.PARLAY_API_KEY = originalKey;
  context.disable();
  manager.disable();
});

function sample(names = ["PRIVATE_HOME", "PRIVATE_AWAY", "Draw"]) {
  return [{
    id: "PRIVATE_EVENT", sport_key: options.sport,
    home_team: "PRIVATE_HOME", away_team: "PRIVATE_AWAY",
    bookmakers: [{ key: options.bookmaker, last_update: "2030-01-01T00:00:00Z", markets: [{
      key: "h2h", last_update: "2029-12-31T23:50:00Z",
      outcomes: names.map((name) => ({ name, price: 2 })),
    }] }],
  }];
}

test("SDK task definition and its demo handler need no networking or prices", async () => {
  globalThis.fetch = async () => { throw new Error("Demo must not use the network"); };
  assert.equal(parlayCoverage.id, "parlayapi-coverage");
  assert.equal(coverageTaskOptions.retry.maxAttempts, 1);
  const result = await coverageTaskOptions.run({ mode: "demo" });
  assert.equal(result.synthetic, true);
  assert.equal(result.completeAndFreshGroups, 1);
  assert.equal(result.rejectedIncompleteGroups, 1);
  assert.doesNotMatch(JSON.stringify(result), /price|PRIVATE|fixture|outcome_name/);
});

test("fractional age beyond threshold fails freshness; derived fixtures fail closed", () => {
  const body = sample();
  body[0].bookmakers[0].markets[0].last_update = "2029-12-31T23:54:59.600Z";
  assert.equal(summarizeResponse(body, options, now).completeAndFreshGroups, 0);
  body[0].home_team = "PRIVATE_HOME (Corners)";
  assert.throws(() => summarizeResponse(body, options, now));
});

test("market age never uses the fresher bookmaker timestamp", () => {
  const result = summarizeResponse(sample(), options, now);
  assert.equal(result.completeGroups, 1);
  assert.equal(result.completeAndFreshGroups, 0);
  assert.equal(result.oldestKnownMarketAgeSeconds, 600);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|price|Draw|pinnacle/);
});

test("two-way and three-way expectations are explicit and incompatible", () => {
  const two = sample(["PRIVATE_HOME", "PRIVATE_AWAY"]);
  assert.equal(summarizeResponse(two, options, now).rejectedIncompleteGroups, 1);
  assert.equal(summarizeResponse(two, { ...options, expectedOutcomes: 2 }, now).completeGroups, 1);
  assert.equal(summarizeResponse(sample(), { ...options, expectedOutcomes: 2 }, now).completeGroups, 0);
});

test("duplicates and unknown selections do not count as complete", () => {
  for (const names of [["PRIVATE_HOME", "PRIVATE_AWAY", "PRIVATE_AWAY"], ["PRIVATE_HOME", "PRIVATE_AWAY", "OTHER"]]) {
    assert.equal(summarizeResponse(sample(names), options, now).completeGroups, 0);
  }
  const duplicate = sample();
  assert.throws(() => summarizeResponse([...duplicate, ...duplicate], options, now));
});

test("unpriced, invalid and missing outcomes are rejected", () => {
  for (const price of [null, "2", 0, 1, NaN, Infinity]) {
    const body = sample();
    body[0].bookmakers[0].markets[0].outcomes[0].price = price as number;
    assert.equal(summarizeResponse(body, options, now).completeGroups, 0);
  }
  assert.equal(summarizeResponse(sample([]), options, now).completeGroups, 0);
});

test("missing, future and timezone-free market dates remain unknown", () => {
  for (const value of [undefined, "2031-01-01T00:00:00Z", "2029-12-31T23:59:00", "invalid"]) {
    const body = sample();
    body[0].bookmakers[0].markets[0].last_update = value as string;
    assert.equal(summarizeResponse(body, options, now).unknownMarketAgeGroups, 1);
    assert.equal(summarizeResponse(body, options, now).completeAndFreshGroups, 0);
  }
});

test("wrong sport, bookmaker and market fail closed", () => {
  for (const change of ["sport", "book", "market"]) {
    const body = sample();
    if (change === "sport") body[0].sport_key = "other";
    if (change === "book") body[0].bookmakers[0].key = "other";
    if (change === "market") body[0].bookmakers[0].markets[0].key = "other";
    assert.throws(() => summarizeResponse(body, options, now));
  }
});

test("live request is single, private and trace-suppressed through body reading", async () => {
  let requests = 0;
  process.env.PARLAY_API_KEY = "PRIVATE_KEY";
  globalThis.fetch = async (url, init) => {
    requests++;
    assert.equal(isTracingSuppressed(context.active()), true);
    const target = new URL(String(url));
    assert.equal(target.origin, "https://parlay-api.com");
    assert.equal(target.pathname, "/v1/sports/soccer_epl/odds");
    assert.equal(target.searchParams.get("bookmakers"), "pinnacle");
    assert.equal(target.searchParams.get("markets"), "h2h");
    assert.equal(target.searchParams.get("oddsFormat"), "decimal");
    assert.equal(new Headers(init?.headers).get("X-API-Key"), "PRIVATE_KEY");
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    assert.doesNotMatch(target.href, /PRIVATE_KEY/);
    return new Response(new ReadableStream({
      async pull(controller) {
        await Promise.resolve();
        assert.equal(isTracingSuppressed(context.active()), true);
        controller.enqueue(new TextEncoder().encode(JSON.stringify(sample())));
        controller.close();
      },
    }));
  };
  const result = await checkCoverage({ mode: "live", ...options });
  assert.equal(requests, 1);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|price|Draw/);
});

test("errors, truncation, malformed JSON and oversize bodies are redacted without retry", async () => {
  for (const response of [
    () => new Response("PRIVATE_SECRET", { status: 401 }),
    () => new Response("PRIVATE_SECRET", { status: 429 }),
    () => new Response("PRIVATE_SECRET", { status: 302 }),
    () => new Response("PRIVATE_SECRET", { status: 500 }),
    () => new Response("PRIVATE_SECRET"),
    () => new Response("[]", { headers: { "x-result-truncated": "true" } }),
    () => new Response("x".repeat(1_000_001)),
  ]) {
    let requests = 0;
    globalThis.fetch = async () => { requests++; return response(); };
    await assert.rejects(checkCoverage({ mode: "live", ...options }), (error: Error) => {
      assert.doesNotMatch(error.message, /PRIVATE/);
      return true;
    });
    assert.equal(requests, 1);
  }
});

test("invalid input and absent environment key never make a request", async () => {
  globalThis.fetch = async () => { assert.fail("Invalid input sent a request"); };
  for (const payload of [null, { apiKey: "PRIVATE_KEY" }, { mode: "live", ...options, sport: "../secret" }, { mode: "live", ...options, bookmaker: "pinnacle,other" }, { mode: "live", ...options, expectedOutcomes: 4 }]) {
    await assert.rejects(checkCoverage(payload));
  }
  delete process.env.PARLAY_API_KEY;
  await assert.rejects(checkCoverage({ mode: "live", ...options }));
});
