import { context } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";

type Options = {
  sport: string;
  bookmaker: string;
  expectedOutcomes: 2 | 3;
  maxAgeSeconds: number;
};
type Group = { complete: boolean; ageSeconds: number | null };
const MAX_BYTES = 1_000_000;
const MAX_EVENTS = 500;
const slug = /^[a-z][a-z0-9_]{0,79}$/;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function invalid(): never {
  throw new Error("Unexpected response shape or scope. No coverage conclusion is available.");
}

function marketTimestamp(value: unknown) {
  if (typeof value !== "string") return NaN;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/i.exec(value);
  if (!match) return NaN;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1] ||
    hour > 23 || minute > 59 || second > 59 ||
    Number(match[7] ?? 0) > 23 || Number(match[8] ?? 0) > 59) return NaN;
  return Date.parse(value);
}

function summarize(groups: Group[], synthetic: boolean, maxAgeSeconds: number) {
  const ages = groups.flatMap((g) => g.ageSeconds === null ? [] : [g.ageSeconds]);
  return {
    synthetic,
    scope: "single_response_only",
    groupsObserved: groups.length,
    completeGroups: groups.filter((g) => g.complete).length,
    rejectedIncompleteGroups: groups.filter((g) => !g.complete).length,
    completeAndFreshGroups: groups.filter((g) =>
      g.complete && g.ageSeconds !== null && g.ageSeconds <= maxAgeSeconds).length,
    unknownMarketAgeGroups: groups.filter((g) => g.ageSeconds === null).length,
    oldestKnownMarketAgeSeconds: ages.length ? Math.max(...ages) : null,
    maxAgeSeconds,
  };
}

export function summarizeResponse(body: unknown, options: Options, now = Date.now()) {
  if (!Array.isArray(body) || body.length > MAX_EVENTS) invalid();
  const seen = new Set<string>();
  const groups: Group[] = [];
  for (const event of body) {
    if (!isRecord(event) || event.sport_key !== options.sport ||
      typeof event.id !== "string" || !event.id || seen.has(event.id) ||
      typeof event.home_team !== "string" || !event.home_team ||
      typeof event.away_team !== "string" || !event.away_team ||
      event.home_team === event.away_team || !Array.isArray(event.bookmakers)) invalid();
    seen.add(event.id);
    if (/\b(corners?|bookings?|cards?)\b/i.test(`${event.home_team} ${event.away_team}`)) invalid();
    if (event.bookmakers.length === 0) {
      groups.push({ complete: false, ageSeconds: null });
      continue;
    }
    if (event.bookmakers.length !== 1) invalid();
    const book = event.bookmakers[0];
    if (!isRecord(book) || book.key !== options.bookmaker || !Array.isArray(book.markets)) invalid();
    if (book.markets.length === 0) {
      groups.push({ complete: false, ageSeconds: null });
      continue;
    }
    if (book.markets.length !== 1) invalid();
    const market = book.markets[0];
    if (!isRecord(market) || market.key !== "h2h" || !Array.isArray(market.outcomes)) invalid();
    const expected = new Set([event.home_team, event.away_team]);
    if (options.expectedOutcomes === 3) expected.add("Draw");
    const names = new Set<string>();
    let complete = market.outcomes.length === options.expectedOutcomes;
    for (const outcome of market.outcomes) {
      if (!isRecord(outcome) || typeof outcome.name !== "string" ||
        !expected.has(outcome.name) || names.has(outcome.name) ||
        typeof outcome.price !== "number" || !Number.isFinite(outcome.price) ||
        outcome.price <= 1 || (outcome.point !== undefined && outcome.point !== null)) {
        complete = false;
      }
      if (isRecord(outcome) && typeof outcome.name === "string") names.add(outcome.name);
    }
    complete = complete && [...expected].every((name) => names.has(name));
    const timestamp = marketTimestamp(market.last_update);
    const age = (now - timestamp) / 1000;
    groups.push({ complete, ageSeconds: Number.isFinite(age) && age >= 0 ? Math.ceil(age) : null });
  }
  return summarize(groups, false, options.maxAgeSeconds);
}

async function fetchResponse(options: Options, key: string) {
  const url = new URL(`https://parlay-api.com/v1/sports/${options.sport}/odds`);
  url.search = new URLSearchParams({
    bookmakers: options.bookmaker,
    regions: "global",
    markets: "h2h",
    oddsFormat: "decimal",
    include: "slim",
  }).toString();
  return context.with(suppressTracing(context.active()), async () => {
    const response = await fetch(url, {
      headers: { "X-API-Key": key, "Accept-Encoding": "identity" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error("API request failed. Check account access or retry manually later.");
    }
    if (["x-result-has-more", "x-result-truncated"].some((header) => {
      const value = response.headers.get(header);
      return value !== null && value !== "false";
    })) {
      await response.body?.cancel();
      invalid();
    }
    if (!response.body) invalid();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_BYTES) invalid();
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  });
}

export async function checkCoverage(payload: unknown) {
  if (!isRecord(payload) || Object.keys(payload).some((key) =>
    !["mode", "sport", "bookmaker", "expectedOutcomes", "maxAgeSeconds"].includes(key))) {
    throw new Error("Use only the documented task fields. Store credentials in environment variables.");
  }
  if (payload.mode === undefined || payload.mode === "demo") {
    return summarize([
      { complete: true, ageSeconds: 20 },
      { complete: false, ageSeconds: 30 },
      { complete: true, ageSeconds: null },
      { complete: true, ageSeconds: 900 },
    ], true, 300);
  }
  if (payload.mode !== "live" || typeof payload.sport !== "string" || !slug.test(payload.sport) ||
    typeof payload.bookmaker !== "string" || !slug.test(payload.bookmaker) ||
    (payload.expectedOutcomes !== 2 && payload.expectedOutcomes !== 3) ||
    typeof payload.maxAgeSeconds !== "number" || !Number.isInteger(payload.maxAgeSeconds) ||
    payload.maxAgeSeconds < 1 || payload.maxAgeSeconds > 3600) {
    throw new Error("Live mode requires one sport, one bookmaker, expectedOutcomes 2 or 3, and maxAgeSeconds 1 through 3600.");
  }
  const key = process.env.PARLAY_API_KEY;
  if (!key || key.length > 512 || !/^[\x21-\x7e]+$/.test(key)) {
    throw new Error("Set PARLAY_API_KEY in the task environment before choosing live mode.");
  }
  const options: Options = {
    sport: payload.sport,
    bookmaker: payload.bookmaker,
    expectedOutcomes: payload.expectedOutcomes,
    maxAgeSeconds: payload.maxAgeSeconds,
  };
  try {
    return summarizeResponse(await fetchResponse(options, key), options);
  } catch {
    throw new Error("The bounded API check failed. No coverage conclusion is available. No automatic retry was sent.");
  }
}
