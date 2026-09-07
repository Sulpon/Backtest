# Dukascopy JForex bridge (proof of concept)

Proves this architecture works end to end:

```
Python FastAPI -> HTTP request -> this Java bridge -> official Dukascopy JForex SDK -> historical EURUSD H1 candles (OHLC + volume) -> JSON -> Python
```

This is a minimal proof of concept only. It supports exactly one thing: fetching
historical **EURUSD H1** candles for a given date range. It does not do database
storage, caching, live streaming, other symbols/timeframes, or anything else -
see the parent project's task notes if you're looking for those.

## Requirements

- **Java 17+** (built/tested with Java 21; `pom.xml` targets bytecode level 17,
  the minimum this SDK version requires).
- No Maven/Gradle installation required on your machine to build - see below.
- A **free Dukascopy demo account** (no live/funded account needed). Register
  one at dukascopy.com if you don't already have one - the "Extended Validity
  DEMO Account" option in their Community area gives one with no expiry.

## Building

From this directory:

```
mvn -q package
```

This downloads the official JForex SDK (`com.dukascopy.dds2:DDS2-jClient-JForex`)
directly from Dukascopy's own public Maven repository
(`https://www.dukascopy.com/client/jforexlib/publicrepo/`) - no login needed
just to build; produces `target/dukascopy-bridge.jar`, a single self-contained
runnable jar (all dependencies bundled via the shade plugin).

If you don't have Maven installed, download the Apache Maven binary
distribution from https://maven.apache.org/download.cgi, extract it anywhere,
and run `<extracted-path>/bin/mvn` instead of `mvn`.

## Configuring your Dukascopy demo credentials

**Never commit real credentials.** This project reads them from environment
variables only - nothing is read from a file, so there's no credentials file
to accidentally commit in the first place.

Set, in the shell you'll run the bridge from:

```
# Windows PowerShell
$env:DUKASCOPY_DEMO_USERNAME = "your_demo_username"
$env:DUKASCOPY_DEMO_PASSWORD = "your_demo_password"

# bash
export DUKASCOPY_DEMO_USERNAME=your_demo_username
export DUKASCOPY_DEMO_PASSWORD=your_demo_password
```

The bridge refuses to start (exits immediately with a clear error) if either
is missing - it never silently runs unauthenticated or with a placeholder.

## Starting the bridge

```
java -jar target/dukascopy-bridge.jar
```

On success you'll see, in order:

```
[bridge] connecting to http://platform.dukascopy.com/demo_3/jforex_3.jnlp ...
[bridge] connected to Dukascopy
[bridge] strategy context ready - historical data available
[bridge] listening on http://localhost:8089/historical
```

This can take up to ~30 seconds (the JForex client downloads/verifies its own
JNLP-launched components on first connect). The process stays running - it's
a long-lived server, not a one-shot script.

## Example request

```
curl "http://localhost:8089/historical?instrument=EURUSD&timeframe=H1&from=2025-01-02&to=2025-01-03"
```

`from`/`to` accept either a plain date (midnight UTC) or a full ISO-8601
instant (`2025-01-02T00:00:00Z`). Only `instrument=EURUSD` and `timeframe=H1`
are accepted in this proof of concept - anything else returns a 400.

## Example response

```json
{
  "instrument": "EURUSD",
  "timeframe": "H1",
  "count": 24,
  "candles": [
    {"timestamp": 1735776000000, "open": 1.03885, "high": 1.03921, "low": 1.03840, "close": 1.03902, "volume": 245.37},
    {"timestamp": 1735779600000, "open": 1.03902, "high": 1.03950, "low": 1.03895, "close": 1.03918, "volume": 198.12}
  ]
}
```

(Exact values above are illustrative - see the actual run report for real
retrieved data.)

## Known limitations of this proof of concept

- Only EURUSD/H1 historical bars - everything else is explicitly rejected,
  not silently substituted.
- No persistence - every request re-fetches from Dukascopy live.
- No retry/reconnect logic beyond what the SDK itself does internally.
- One shared JForex "strategy" context serves every request - fine for a
  single-user proof of concept, not evaluated for concurrent load.
- `BID` offer side is used for OHLC/volume (matching the SDK's own example
  code convention) - `ASK` side is not exposed.
