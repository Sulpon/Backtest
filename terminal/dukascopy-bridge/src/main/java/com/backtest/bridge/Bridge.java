package com.backtest.bridge;

import com.dukascopy.api.Filter;
import com.dukascopy.api.IAccount;
import com.dukascopy.api.IBar;
import com.dukascopy.api.IContext;
import com.dukascopy.api.IHistory;
import com.dukascopy.api.IMessage;
import com.dukascopy.api.IStrategy;
import com.dukascopy.api.ITick;
import com.dukascopy.api.Instrument;
import com.dukascopy.api.JFException;
import com.dukascopy.api.OfferSide;
import com.dukascopy.api.Period;
import com.dukascopy.api.system.ClientFactory;
import com.dukascopy.api.system.IClient;
import com.dukascopy.api.system.ISystemListener;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.List;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/**
 * Minimal proof-of-concept bridge: proves the architecture
 *   Python FastAPI -> HTTP -> this Java process -> official JForex SDK -> Dukascopy
 * can retrieve real historical EURUSD H1 candles (OHLC + volume) end to end.
 *
 * Deliberately supports ONLY EURUSD/H1 historical bars - no other instruments,
 * timeframes, live streaming, caching, or persistence. See README.md.
 *
 * Historical data (IHistory) is only reachable from inside a running
 * IStrategy's onStart(IContext) callback - that's how the official SDK is
 * designed, not a limitation added here. So this process starts exactly one
 * long-lived strategy at boot whose only job is to capture the IContext,
 * then answers every HTTP request using that same context.
 */
public final class Bridge {

    private static final String JNLP_URL = "http://platform.dukascopy.com/demo_3/jforex_3.jnlp";
    private static final int HTTP_PORT = 8089;
    private static final int CONNECT_TIMEOUT_SECONDS = 30;

    private static volatile IContext context;
    private static volatile IClient client;

    public static void main(String[] args) throws Exception {
        String username = System.getenv("DUKASCOPY_DEMO_USERNAME");
        String password = System.getenv("DUKASCOPY_DEMO_PASSWORD");
        if (username == null || username.isBlank() || password == null || password.isBlank()) {
            System.err.println(
                "ERROR: DUKASCOPY_DEMO_USERNAME and DUKASCOPY_DEMO_PASSWORD environment variables "
                + "must both be set (a free Dukascopy demo account - see README.md). Refusing to start."
            );
            System.exit(1);
        }

        final IClient client = ClientFactory.getDefaultInstance();
        Bridge.client = client;
        final CompletableFuture<Void> connected = new CompletableFuture<>();
        final CompletableFuture<IContext> contextReady = new CompletableFuture<>();

        client.setSystemListener(new ISystemListener() {
            @Override
            public void onStart(long processId) {
                System.out.println("[bridge] strategy started, processId=" + processId);
            }

            @Override
            public void onStop(long processId) {
                System.out.println("[bridge] strategy stopped, processId=" + processId);
            }

            @Override
            public void onConnect() {
                System.out.println("[bridge] connected to Dukascopy");
                connected.complete(null);
            }

            @Override
            public void onDisconnect() {
                System.err.println("[bridge] disconnected from Dukascopy");
            }
        });

        System.out.println("[bridge] connecting to " + JNLP_URL + " ...");
        client.connect(JNLP_URL, username, password);

        try {
            connected.get(CONNECT_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        } catch (Exception e) {
            System.err.println("[bridge] BLOCKED: failed to connect/authenticate to Dukascopy within "
                + CONNECT_TIMEOUT_SECONDS + "s: " + e.getMessage());
            System.exit(2);
            return;
        }

        Set<Instrument> instruments = new HashSet<>();
        instruments.add(Instrument.EURUSD);
        client.setSubscribedInstruments(instruments);

        client.startStrategy(new IStrategy() {
            @Override
            public void onStart(IContext ctx) throws JFException {
                context = ctx;
                contextReady.complete(ctx);
                System.out.println("[bridge] strategy context ready - historical data available");
            }

            @Override
            public void onTick(Instrument instrument, ITick tick) throws JFException {
                // not used - this bridge only serves historical data on demand
            }

            @Override
            public void onBar(Instrument instrument, Period period, IBar askBar, IBar bidBar) throws JFException {
                // not used
            }

            @Override
            public void onMessage(IMessage message) throws JFException {
                // not used
            }

            @Override
            public void onAccount(IAccount account) throws JFException {
                // not used
            }

            @Override
            public void onStop() throws JFException {
                // not used
            }
        });

        try {
            contextReady.get(CONNECT_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        } catch (Exception e) {
            System.err.println("[bridge] BLOCKED: strategy never received a context: " + e.getMessage());
            System.exit(3);
            return;
        }

        HttpServer server = HttpServer.create(new InetSocketAddress(HTTP_PORT), 0);
        server.createContext("/historical", Bridge::handleHistorical);
        server.setExecutor(null);
        server.start();
        System.out.println("[bridge] listening on http://localhost:" + HTTP_PORT + "/historical");
    }

    private static void handleHistorical(HttpExchange exchange) throws IOException {
        try {
            Map<String, String> params = parseQuery(exchange.getRequestURI());
            String instrumentParam = params.getOrDefault("instrument", "");
            String timeframeParam = params.getOrDefault("timeframe", "");
            String fromParam = params.get("from");
            String toParam = params.get("to");

            // POC scope is deliberately fixed to EURUSD/H1 only (see README.md
            // and the task this bridge was built for) - anything else is a
            // client error, not silently substituted.
            if (!"EURUSD".equalsIgnoreCase(instrumentParam)) {
                respondError(exchange, 400, "Only instrument=EURUSD is supported in this proof of concept.");
                return;
            }
            if (!"H1".equalsIgnoreCase(timeframeParam)) {
                respondError(exchange, 400, "Only timeframe=H1 is supported in this proof of concept.");
                return;
            }
            if (fromParam == null || toParam == null) {
                respondError(exchange, 400, "Both 'from' and 'to' query parameters are required (ISO-8601, e.g. 2025-01-02T00:00:00Z).");
                return;
            }

            long fromMillis;
            long toMillis;
            try {
                fromMillis = parseTimestamp(fromParam);
                toMillis = parseTimestamp(toParam);
            } catch (DateTimeParseException e) {
                respondError(exchange, 400, "Could not parse 'from'/'to' as ISO-8601 timestamps: " + e.getMessage());
                return;
            }

            IContext ctx = context;
            if (ctx == null) {
                respondError(exchange, 503, "Bridge is not yet connected to Dukascopy.");
                return;
            }

            // Diagnostic logging (task-requested, temporary) - full request
            // parameters and connection state before the actual call, so a
            // count=0 response can be correlated with exactly what was asked
            // for rather than guessed at afterward.
            java.time.Instant fromInstant = java.time.Instant.ofEpochMilli(fromMillis);
            java.time.Instant toInstant = java.time.Instant.ofEpochMilli(toMillis);
            System.out.println("[bridge][diag] request: instrument=EURUSD period=ONE_HOUR offerSide=BID filter=NO_FILTER"
                + " from=" + fromMillis + " (" + fromInstant + " UTC)"
                + " to=" + toMillis + " (" + toInstant + " UTC)"
                + " client.isConnected()=" + ClientFactory.getDefaultInstance().isConnected());

            IHistory history = ctx.getHistory();
            List<IBar> bars = history.getBars(
                Instrument.EURUSD, Period.ONE_HOUR, OfferSide.BID, Filter.NO_FILTER, fromMillis, toMillis
            );
            System.out.println("[bridge][diag] first attempt returned " + bars.size() + " bars");

            // One diagnostic retry after a short pause if the first attempt
            // came back empty - distinguishes "genuinely no data for this
            // range" (both attempts empty) from "background history-cache
            // download was still in flight on the first call" (second
            // attempt succeeds). Logged either way, never silent.
            if (bars.isEmpty()) {
                System.out.println("[bridge][diag] empty on first attempt - waiting 3s and retrying once...");
                try {
                    Thread.sleep(3000);
                } catch (InterruptedException ignored) {
                    Thread.currentThread().interrupt();
                }
                bars = history.getBars(
                    Instrument.EURUSD, Period.ONE_HOUR, OfferSide.BID, Filter.NO_FILTER, fromMillis, toMillis
                );
                System.out.println("[bridge][diag] retry attempt returned " + bars.size() + " bars");
            }

            // ROOT CAUSE FIX: getBars() is IHistory's SYNCHRONOUS accessor -
            // per Dukascopy's own docs it "will all be done in the same
            // thread blocking strategy execution", but empirically (this
            // investigation) that blocking/auto-download does not reliably
            // trigger for arbitrary older ranges on a plain live IClient.
            // ITesterClient was investigated and ruled out (this client
            // fails `instanceof ITesterClient` - it would require a
            // different application mode entirely, not a runtime cast).
            // IHistory.readBars(...) is the SDK's OWN documented explicit
            // alternative: an asynchronous load with a completion callback
            // (LoadingProgressListener.loadingFinished), available directly
            // on IHistory - no ITesterClient needed. Used here ONLY when
            // getBars() already came back empty (the fast path for the
            // common case - most ranges already work via plain getBars() -
            // is untouched), collecting bars via
            // LoadingDataListener.newBar(...) and using those instead of
            // re-calling getBars() afterward (whose blocking behavior is
            // exactly what's already been shown to be unreliable here).
            if (bars.isEmpty()) {
                System.out.println("[bridge][diag] still empty after getBars() retry - explicitly loading via IHistory.readBars()...");
                final List<IBar> readBarsResult = new java.util.concurrent.CopyOnWriteArrayList<>();
                final CompletableFuture<Boolean> readDone = new CompletableFuture<>();
                try {
                    history.readBars(
                        Instrument.EURUSD, Period.ONE_HOUR, OfferSide.BID, Filter.NO_FILTER, fromMillis, toMillis,
                        new com.dukascopy.api.LoadingDataListener() {
                            @Override
                            public void newTick(Instrument instrument, long time, double ask, double bid, double askVolume, double bidVolume) {
                                // not used - this bridge only wants bars
                            }

                            @Override
                            public void newBar(Instrument instrument, Period period, OfferSide side, long time,
                                                double open, double close, double low, double high, double vol) {
                                // Parameter order confirmed from Dukascopy's own
                                // LoadingDataListener docs: (open, close, low, high, vol) -
                                // NOT the OHLC order getBars()'s IBar uses. Wrapped in a
                                // minimal IBar so downstream JSON-building code (which
                                // reads getOpen/getHigh/getLow/getClose/getVolume) needs
                                // no special-casing for this path.
                                readBarsResult.add(new com.dukascopy.api.IBar() {
                                    @Override public double getOpen() { return open; }
                                    @Override public double getClose() { return close; }
                                    @Override public double getLow() { return low; }
                                    @Override public double getHigh() { return high; }
                                    @Override public double getVolume() { return vol; }
                                    @Override public long getTime() { return time; }
                                });
                            }
                        },
                        new com.dukascopy.api.LoadingProgressListener() {
                            @Override
                            public void dataLoaded(long startTime, long endTime, long currentPercent, String currentTask) {
                                System.out.println("[bridge][diag]   readBars progress: " + currentPercent + "% - " + currentTask);
                            }

                            @Override
                            public void loadingFinished(boolean allDataLoaded, long start, long end, long finalPercent) {
                                System.out.println("[bridge][diag]   readBars finished: allDataLoaded=" + allDataLoaded
                                    + " range=" + java.time.Instant.ofEpochMilli(start) + " -> " + java.time.Instant.ofEpochMilli(end));
                                readDone.complete(allDataLoaded);
                            }

                            @Override
                            public boolean stopJob() {
                                return false;
                            }
                        }
                    );
                    Boolean allDataLoaded = readDone.get(60, TimeUnit.SECONDS);
                    System.out.println("[bridge][diag]   readBars collected " + readBarsResult.size() + " bars, allDataLoaded=" + allDataLoaded);
                    bars = readBarsResult;
                } catch (Throwable t) {
                    // Own try/catch(Throwable) so a failure here is
                    // unambiguously localized and, per the earlier "Empty
                    // reply from server" incident, never escapes uncaught.
                    System.err.println("[bridge][diag] THROWABLE during readBars: " + t);
                    t.printStackTrace();
                }
            }

            // Diagnostic only (task-requested): IDataService.isOfflineTime/
            // getOfflineTimeDomains is Dukascopy's OWN documented mechanism
            // for querying known feed-outage windows per instrument - if the
            // requested range overlaps one, that's a real, queryable
            // server-side data gap, not a bridge bug or an age-based limit.
            // getTimeOfFirstCandle tells us the account's earliest available
            // EURUSD/H1 candle, for cross-checking against ranges that
            // returned 0. None of this changes what's fetched or returned -
            // additional response fields only.
            com.dukascopy.api.IDataService dataService = ctx.getDataService();
            long firstCandleTime = dataService.getTimeOfFirstCandle(Instrument.EURUSD, Period.ONE_HOUR);
            boolean fromIsOffline = dataService.isOfflineTime(fromMillis, Instrument.EURUSD);
            boolean toIsOffline = dataService.isOfflineTime(toMillis, Instrument.EURUSD);
            java.util.Set<com.dukascopy.api.ITimeDomain> offlineDomains =
                dataService.getOfflineTimeDomains(fromMillis, toMillis, Instrument.EURUSD);
            System.out.println("[bridge][diag] firstAvailableCandleTime=" + firstCandleTime
                + " (" + java.time.Instant.ofEpochMilli(firstCandleTime) + " UTC)"
                + " fromIsOfflineTime=" + fromIsOffline + " toIsOfflineTime=" + toIsOffline
                + " offlineDomainsOverlappingRange=" + offlineDomains.size());
            for (com.dukascopy.api.ITimeDomain d : offlineDomains) {
                System.out.println("[bridge][diag]   offline domain: " + java.time.Instant.ofEpochMilli(d.getStart())
                    + " -> " + java.time.Instant.ofEpochMilli(d.getEnd()) + " UTC");
            }

            StringBuilder json = new StringBuilder();
            json.append("{\"instrument\":\"EURUSD\",\"timeframe\":\"H1\",\"count\":").append(bars.size())
                .append(",\"diagnostic\":{")
                .append("\"firstAvailableCandleTime\":").append(firstCandleTime).append(',')
                .append("\"fromIsOfflineTime\":").append(fromIsOffline).append(',')
                .append("\"toIsOfflineTime\":").append(toIsOffline).append(',')
                .append("\"offlineDomainCount\":").append(offlineDomains.size())
                .append("},\"candles\":[");
            for (int i = 0; i < bars.size(); i++) {
                IBar bar = bars.get(i);
                if (i > 0) json.append(',');
                json.append('{')
                    .append("\"timestamp\":").append(bar.getTime()).append(',')
                    .append("\"open\":").append(bar.getOpen()).append(',')
                    .append("\"high\":").append(bar.getHigh()).append(',')
                    .append("\"low\":").append(bar.getLow()).append(',')
                    .append("\"close\":").append(bar.getClose()).append(',')
                    .append("\"volume\":").append(bar.getVolume())
                    .append('}');
            }
            json.append("]}");

            respondJson(exchange, 200, json.toString());
        } catch (JFException e) {
            System.err.println("[bridge][diag] JFException during getBars:");
            e.printStackTrace();
            respondError(exchange, 502, "JForex API error: " + e.getMessage());
        } catch (Throwable t) {
            // Widened from Exception to Throwable (task-requested
            // instrumentation): com.sun.net.httpserver.HttpServer closes the
            // connection with NO response at all - not even a 500 - if a
            // Throwable escapes a handler uncaught, which is indistinguishable
            // from "curl: (52) Empty reply from server" on the client side.
            // This guarantees whatever actually happened gets logged AND the
            // client still gets a real HTTP response, without changing any
            // already-handled behavior.
            System.err.println("[bridge][diag] Unexpected THROWABLE during /historical handling:");
            t.printStackTrace();
            respondError(exchange, 500, "Unexpected bridge error: " + t.getClass().getName() + ": " + t.getMessage());
        }
    }

    private static long parseTimestamp(String value) {
        // Accept a plain date (2025-01-02, midnight UTC) or a full ISO-8601
        // instant (2025-01-02T00:00:00Z) - whichever the caller finds
        // convenient for this small POC.
        if (value.length() == 10) {
            return Instant.parse(value + "T00:00:00Z").toEpochMilli();
        }
        return Instant.parse(value).toEpochMilli();
    }

    private static Map<String, String> parseQuery(URI uri) {
        Map<String, String> result = new java.util.HashMap<>();
        String query = uri.getRawQuery();
        if (query == null) return result;
        for (String pair : query.split("&")) {
            int eq = pair.indexOf('=');
            if (eq < 0) continue;
            String key = java.net.URLDecoder.decode(pair.substring(0, eq), StandardCharsets.UTF_8);
            String value = java.net.URLDecoder.decode(pair.substring(eq + 1), StandardCharsets.UTF_8);
            result.put(key, value);
        }
        return result;
    }

    private static void respondJson(HttpExchange exchange, int status, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream os = exchange.getResponseBody()) {
            os.write(bytes);
        }
    }

    private static void respondError(HttpExchange exchange, int status, String message) throws IOException {
        String escaped = message.replace("\"", "'");
        respondJson(exchange, status, "{\"error\":\"" + escaped + "\"}");
    }

    private Bridge() {
    }
}
