# ParlayAPI coverage check

A manually triggered [Trigger.dev](https://trigger.dev) task for developers building private sports research apps. Check whether one bookmaker's returned head-to-head markets contain every expected outcome, then count which complete groups satisfy your chosen market-age threshold. Missing Draw prices must not silently become a two-way market.

The default demo uses four synthetic completeness/age records. It contains no odds, teams or fixtures and makes no API request. Live mode makes one request with your own ParlayAPI key and returns aggregate diagnostics only. It does not schedule polling, place bets or call a model.

## Run the offline example

Use Node.js 22 and npm from this directory:

```bash
npm ci
npm run check
npm test
npm run demo
```

The demo reports four observed groups, three complete groups, one incomplete group and one complete group within its 300-second threshold. One complete group has an unknown timestamp and another is too old. These are fictional metadata records, not sportsbook observations.

## Run a task in Trigger.dev

1. Create a Trigger.dev project and replace `<your-project-ref>` in `trigger.config.ts` with its project reference.
2. Run `npm run dev` and complete the CLI authentication flow.
3. In the Trigger.dev dashboard, open the `parlayapi-coverage` task's test panel. Run it with `{"mode":"demo"}`.
4. For live mode, [create a ParlayAPI account](https://parlay-api.com/signup?utm_source=triggerdev&utm_medium=integration&utm_campaign=coverage_example), obtain your own API key and check the current [access and allowance information](https://parlay-api.com/pricing). Set `PARLAY_API_KEY` in your Trigger.dev project's environment variables. For local development, copy `.env.example` to `.env` and populate it locally.
5. Trigger a live check with only the following configuration:

```json
{
  "mode": "live",
  "sport": "soccer_epl",
  "bookmaker": "pinnacle",
  "expectedOutcomes": 3,
  "maxAgeSeconds": 300
}
```

This is a request configuration, not a promise that this bookmaker or league currently has qualifying markets. Choose API keys and settlement scope appropriate to your own integration. Set `expectedOutcomes` to `2` for a genuinely two-way market or `3` when the market includes Draw. The task never guesses this from the number of returned outcomes. See [ParlayAPI documentation](https://parlay-api.com/docs) for supported request keys.

The request is:

```text
GET https://parlay-api.com/v1/sports/soccer_epl/odds?bookmakers=pinnacle&regions=global&markets=h2h&oddsFormat=decimal&include=slim
X-API-Key: <environment variable, never a task field>
```

Never paste credentials, source responses or customer data into task payloads. Trigger.dev stores payloads before this code validates them. The API key belongs only in the environment. The task has no API-key input field and no arbitrary-URL input field.

Deployment is optional: run `npm run deploy` after testing in your own Trigger.dev project. Each manually triggered run permits one attempt. There is no schedule and no automatic HTTP retry. A failed request may still consume API allowance; inspect it before manually repeating the task. Trigger.dev runs may also incur costs under your account's terms.

## What the result means

All counts refer only to the single response that was read. They do not establish exhaustive sportsbook coverage, availability on other endpoints or future delivery. Empty responses produce zero observed groups, not proof that a market is unsupported.

- `completeGroups`: exactly the expected unique home, away and, if requested, Draw selections, each with a finite decimal price greater than one. Duplicate, missing, unknown or unpriced selections reject the group.
- `rejectedIncompleteGroups`: returned event groups missing the chosen bookmaker/market or lacking the expected outcomes. Rejected groups never contribute to `completeAndFreshGroups`.
- `completeAndFreshGroups`: complete groups whose market timestamp is no older than `maxAgeSeconds`.
- `unknownMarketAgeGroups`: groups with absent, invalid, future or timezone-free market timestamps. Bookmaker heartbeat timestamps never substitute for market timestamps.
- `oldestKnownMarketAgeSeconds`: the oldest returned market age, rounded up. This is not a measurement of source-to-customer latency or when a price last changed.

The parser rejects mismatched sport/bookmaker/market scope, duplicate event IDs, multiple market groups, obvious Corners/Bookings/Cards fixture labels, unexpected envelopes, advertised partial responses and responses above 500 events or 1 MB. The derived-label check is conservative and cannot establish settlement equivalence from names alone. Confirm the market rules in your integration. The network deadline is 10 seconds and the task's compute duration is bounded to 30 seconds.

## Privacy and verification

Prices and participant identities are read only inside the task and are not returned, logged, saved to files or passed to another service by this example. HTTP work runs inside an OpenTelemetry `suppressTracing` context so instrumentations that honor suppression do not capture the credentialed request. Do not add request/response logging or instrumentation that ignores suppression. Trigger.dev still receives the ordinary task configuration and aggregate output.

Local tests exercise the actual SDK task definition and its handler, mocked HTTP responses, asynchronous tracing suppression, malformed data and secret-safe errors. They do not represent a deployed Trigger.dev run, an exported-trace audit of a configured project, or a live sportsbook acceptance test. Before using a customized deployment, inspect its instrumentation with a dummy credential to verify no sensitive headers or response bodies enter telemetry.

This example is for private, internal diagnostics under your ParlayAPI account's [terms](https://parlay-api.com/terms). The example code does not grant rights to publicly redisplay, redistribute or white-label sportsbook data. Do not publish your live responses or expose this task as a public odds service.

References: [Trigger.dev tasks and retry configuration](https://trigger.dev/docs/tasks/overview), [Trigger.dev project configuration](https://trigger.dev/docs/config/config-file), and the [ParlayAPI notebook response conventions](https://github.com/JacobiusMakes/parlayapi-notebooks).
