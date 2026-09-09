import { accessSync, constants, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { assertBrowserStagingTarget } from "./config.mjs";

const candidates = [
  process.env.DROP_OS_CHROME_PATH,
  "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
].filter(Boolean);

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const PAGE_TARGET_TYPES = new Set(["page", "iframe", "webview"]);
const WORKER_TARGET_TYPES = new Set([
  "worker", "shared_worker", "service_worker", "worklet", "shared_storage_worklet"
]);
const COVERED_TARGET_TYPES = new Set([...PAGE_TARGET_TYPES, ...WORKER_TARGET_TYPES]);
const TARGET_FILTER = Object.freeze(
  [...COVERED_TARGET_TYPES].map(type => Object.freeze({ type, exclude: false })).concat(
    Object.freeze({ exclude: true })
  )
);
const FETCH_PATTERNS = Object.freeze([
  Object.freeze({ urlPattern: "*", requestStage: "Request" })
]);

function chromePath() {
  for (const path of candidates) {
    try { accessSync(path, constants.X_OK); return path; } catch { /* next */ }
  }
  throw new Error("chrome_not_available");
}

async function waitFor(getValue, timeoutMs, assertSafe = () => undefined) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    assertSafe();
    const value = await getValue().catch(() => null);
    assertSafe();
    if (value) return value;
    await delay(100);
  }
  throw new Error("browser_timeout");
}

function cdpSocket(url) {
  const socket = new WebSocket(url);
  let sequence = 0;
  const pending = new Map();
  const listeners = new Map();
  const closePending = () => {
    for (const waiter of pending.values()) waiter.reject(new Error("cdp_connection_closed"));
    pending.clear();
  };
  socket.addEventListener("message", event => {
    const message = JSON.parse(String(event.data));
    if (!message.id) {
      for (const listener of listeners.get(message.method) ?? []) {
        listener(message.params ?? {}, message.sessionId ?? null);
      }
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    message.error ? waiter.reject(new Error("cdp_command_failed")) : waiter.resolve(message.result);
  });
  socket.addEventListener("close", closePending, { once: true });
  return {
    open: new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error("cdp_connection_failed")), { once: true });
    }),
    send(method, params = {}, sessionId = null) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    on(method, listener) {
      const registered = listeners.get(method) ?? new Set();
      registered.add(listener);
      listeners.set(method, registered);
      return () => {
        registered.delete(listener);
        if (registered.size === 0) listeners.delete(method);
      };
    },
    close() { socket.close(); }
  };
}

const expression = (selector, action) => `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; ${action}; return true; })()`;

async function evaluate(cdp, source, sessionId) {
  const result = await cdp.send(
    "Runtime.evaluate",
    { expression: source, returnByValue: true, awaitPromise: true },
    sessionId
  );
  if (result?.exceptionDetails) throw new Error("browser_script_failed");
  return result?.result?.value;
}

function allowedBrowserRequest(allowedHosts, rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { return false; }
  if (["data:", "blob:", "about:"].includes(url.protocol)) return true;
  return url.protocol === "https:" && !url.username && !url.password && !url.port &&
    allowedHosts.has(url.hostname);
}

function runtimeEgressLockdownSource() {
  return `(() => {
    const refuse = () => { throw new TypeError("browser_non_http_transport_refused"); };
    const names = [
      "RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel",
      "WebSocket", "WebTransport", "WebTransportError", "TCPSocket", "UDPSocket"
    ];
    for (const name of names) {
      try {
        Object.defineProperty(globalThis, name, {
          value: refuse,
          writable: false,
          configurable: false
        });
      } catch { return false; }
    }
    try {
      Object.defineProperty(globalThis, "__droposTruthEgressLocked", {
        value: true,
        writable: false,
        configurable: false
      });
    } catch { return false; }
    return true;
  })()`;
}

const AUTO_ATTACH = Object.freeze({
  autoAttach: true,
  waitForDebuggerOnStart: true,
  flatten: true,
  filter: TARGET_FILTER
});

/**
 * Install one browser-wide fail-closed network boundary.
 *
 * Chrome's Fetch domain is target-scoped. The browser connection therefore
 * auto-attaches every page, popup, OOPIF and worker while it is paused, installs
 * the same Fetch guard in that session, disables non-HTTP transports, recursively
 * enables auto-attach for descendants, and only then resumes its JavaScript.
 */
export async function installBrowserRequestBoundary(cdp, config) {
  assertBrowserStagingTarget(config);
  const allowedHosts = new Set(config.networkAllowedHosts);
  const pendingOperations = new Set();
  const targetSessions = new Map();
  const configuredSessions = new Set();
  const permittedUnpausedTargetIds = new Set();
  const removers = [];
  let initialPageTargetId = null;
  let refused = false;
  let refusalReason = null;
  let closed = false;

  const unsafe = (reason = "browser_network_target_refused") => {
    refused = true;
    refusalReason ??= reason;
  };
  const track = operation => {
    pendingOperations.add(operation);
    void operation.finally(() => pendingOperations.delete(operation));
    return operation;
  };

  const pageSession = () => {
    const initial = initialPageTargetId ? targetSessions.get(initialPageTargetId) : null;
    if (initial?.type === "page" && configuredSessions.has(initial.sessionId)) {
      return { targetId: initialPageTargetId, sessionId: initial.sessionId };
    }
    for (const [targetId, entry] of targetSessions) {
      if (entry.type === "page" && configuredSessions.has(entry.sessionId)) {
        return { targetId, sessionId: entry.sessionId };
      }
    }
    return null;
  };

  async function configureTarget(event) {
    const sessionId = typeof event?.sessionId === "string" ? event.sessionId : "";
    const targetInfo = event?.targetInfo && typeof event.targetInfo === "object"
      ? event.targetInfo
      : {};
    const targetId = typeof targetInfo.targetId === "string" ? targetInfo.targetId : "";
    const type = typeof targetInfo.type === "string" ? targetInfo.type : "";
    if (!sessionId || !targetId || !COVERED_TARGET_TYPES.has(type)) {
      unsafe("browser_target_metadata_invalid");
      return;
    }
    if (
      event?.waitingForDebugger !== true &&
      targetId !== initialPageTargetId &&
      !permittedUnpausedTargetIds.has(targetId)
    ) {
      // A future target which was not paused could already have performed
      // network I/O before its Fetch boundary existed.
      const url = typeof targetInfo.url === "string" ? targetInfo.url : "";
      const urlState = ["", "about:blank"].includes(url) ? "blank" : "navigated";
      let urlClass = urlState === "blank" ? "blank" : "blocked";
      if (urlState !== "blank") {
        try {
          const parsed = new URL(url);
          urlClass = ["chrome:", "chrome-extension:", "devtools:"].includes(parsed.protocol)
            ? "internal"
            : allowedBrowserRequest(allowedHosts, url)
              ? "allowed"
              : "blocked";
        } catch {
          urlClass = "blocked";
        }
      }
      const ancestry = typeof targetInfo.openerId === "string" && targetInfo.openerId
        ? "child"
        : "root";
      // Chrome component workers (for example the built-in PDF viewer) are
      // outside the web-origin threat surface and cannot be created by the
      // staging application. Recent hosted runners expose one as an already-
      // running root target even with extensions disabled. Ignore that exact
      // internal case; every HTTP(S), child and future web target still fails
      // closed unless Chromium paused it before execution.
      if (type === "service_worker" && urlClass === "internal" && ancestry === "root") {
        return;
      }
      unsafe(`browser_target_unpaused_${type}_${urlState}_${urlClass}_${ancestry}`);
      return;
    }

    targetSessions.set(targetId, { sessionId, type });
    let configureStage = "fetch_enable";
    try {
      // Fetch is first: no target is resumed while it has an unguarded network layer.
      await cdp.send("Fetch.enable", { patterns: FETCH_PATTERNS }, sessionId);
      configureStage = "network_enable";
      await cdp.send("Network.enable", {}, sessionId);
      configureStage = "service_worker_bypass";
      await cdp.send("Network.setBypassServiceWorker", { bypass: true }, sessionId);
      configureStage = "runtime_enable";
      await cdp.send("Runtime.enable", {}, sessionId);

      const lockdown = runtimeEgressLockdownSource();
      if (PAGE_TARGET_TYPES.has(type)) {
        configureStage = "page_enable";
        await cdp.send("Page.enable", {}, sessionId);
        configureStage = "early_lockdown";
        await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: lockdown }, sessionId);
      }
      configureStage = "runtime_lockdown";
      const lockdownResult = await cdp.send(
        "Runtime.evaluate",
        { expression: lockdown, returnByValue: true },
        sessionId
      );
      if (lockdownResult?.exceptionDetails || lockdownResult?.result?.value !== true) {
        throw new Error("browser_egress_lockdown_failed");
      }

      // Auto-attach is not recursive by default. Establish it in every child
      // session before resuming so workers inside OOPIFs cannot create a gap.
      configureStage = "recursive_auto_attach";
      await cdp.send("Target.setAutoAttach", AUTO_ATTACH, sessionId);
      configuredSessions.add(sessionId);
      configureStage = "resume";
      await cdp.send("Runtime.runIfWaitingForDebugger", {}, sessionId);
    } catch {
      unsafe(`browser_target_${configureStage}_failed`);
    }
  }

  removers.push(cdp.on("Target.attachedToTarget", event => {
    track(configureTarget(event));
  }));

  removers.push(cdp.on("Fetch.requestPaused", (event, sessionId) => {
    const operation = (async () => {
      if (!sessionId || !configuredSessions.has(sessionId)) {
        unsafe("browser_request_unbound");
        return;
      }
      if (allowedBrowserRequest(allowedHosts, String(event?.request?.url ?? ""))) {
        await cdp.send("Fetch.continueRequest", { requestId: event.requestId }, sessionId);
        return;
      }
      unsafe();
      await cdp.send("Fetch.failRequest", {
        requestId: event.requestId,
        errorReason: "BlockedByClient"
      }, sessionId);
    })().catch(unsafe);
    track(operation);
  }));

  // These events are a second fail-closed signal if a future Chromium release
  // exposes a non-HTTP primitive despite the pre-document runtime lockdown.
  for (const [method, reason] of [
    ["Network.webSocketCreated", "browser_websocket_refused"],
    ["Network.webTransportCreated", "browser_webtransport_refused"],
    ["Network.directTCPSocketCreated", "browser_direct_socket_refused"]
  ]) {
    removers.push(cdp.on(method, () => unsafe(reason)));
  }
  removers.push(cdp.on("Target.targetCrashed", () => unsafe("browser_target_crashed")));

  try {
    await cdp.send("Target.setDiscoverTargets", {
      discover: true,
      filter: TARGET_FILTER
    });
    const initialTargets = await cdp.send("Target.getTargets", { filter: TARGET_FILTER });
    for (const target of initialTargets?.targetInfos ?? []) {
      const targetId = typeof target?.targetId === "string" ? target.targetId : "";
      const type = typeof target?.type === "string" ? target.type : "";
      const url = typeof target?.url === "string" ? target.url : "";
      // Chromium may report an already-existing startup target as not paused,
      // even with waitForDebuggerOnStart. It is safe to attach only when that
      // exact target was inventoried before auto-attach and has never navigated.
      if (targetId && COVERED_TARGET_TYPES.has(type) && ["", "about:blank"].includes(url)) {
        permittedUnpausedTargetIds.add(targetId);
      }
    }
    const initialPage = initialTargets?.targetInfos?.find(
      target => target?.type === "page" && target?.url === "about:blank"
    );
    initialPageTargetId = typeof initialPage?.targetId === "string"
      ? initialPage.targetId
      : null;
    await cdp.send("Target.setAutoAttach", AUTO_ATTACH);
  } catch {
    unsafe();
    throw new Error("browser_target_coverage_unavailable");
  }

  return {
    assertSafe() {
      if (refused || closed) throw new Error(refusalReason ?? "browser_network_target_refused");
    },
    async settle() {
      // Target configuration can recursively cause more attached-target events.
      // Drain until the set remains empty across a microtask boundary.
      while (pendingOperations.size) {
        await Promise.allSettled(Array.from(pendingOperations));
        await Promise.resolve();
      }
      if (refused || closed) throw new Error(refusalReason ?? "browser_network_target_refused");
    },
    async waitForPageSession(timeoutMs) {
      return waitFor(
        async () => {
          await Promise.resolve();
          return pageSession();
        },
        timeoutMs,
        () => {
          if (refused || closed) {
            throw new Error(refusalReason ?? "browser_target_coverage_unavailable");
          }
        }
      );
    },
    close() {
      closed = true;
      for (const remove of removers) remove();
    }
  };
}

async function assertExpectedOrigin(cdp, expectedOrigin, sessionId, requestBoundary) {
  requestBoundary.assertSafe();
  const landedOrigin = await evaluate(cdp, "location.origin", sessionId);
  requestBoundary.assertSafe();
  if (landedOrigin !== expectedOrigin) throw new Error("browser_target_redirected");
  const locked = await evaluate(
    cdp,
    "globalThis.__droposTruthEgressLocked === true",
    sessionId
  );
  requestBoundary.assertSafe();
  if (locked !== true) throw new Error("browser_egress_lockdown_missing");
}

async function navigate(cdp, url, expectedOrigin, timeoutMs, sessionId, requestBoundary) {
  requestBoundary.assertSafe();
  await cdp.send("Page.navigate", { url }, sessionId);
  requestBoundary.assertSafe();
  await waitFor(
    () => evaluate(cdp, "document.readyState === 'complete'", sessionId),
    timeoutMs,
    () => requestBoundary.assertSafe()
  );
  await requestBoundary.settle();
  await assertExpectedOrigin(cdp, expectedOrigin, sessionId, requestBoundary);
}

async function waitForAuthenticatedNavigation(
  cdp,
  loginUrl,
  expectedOrigin,
  timeoutMs,
  sessionId,
  requestBoundary
) {
  const loginPath = new URL(loginUrl).pathname;
  await waitFor(
    () => evaluate(
      cdp,
      `location.origin === ${JSON.stringify(expectedOrigin)} && location.pathname !== ${JSON.stringify(loginPath)}`,
      sessionId
    ),
    timeoutMs,
    () => requestBoundary.assertSafe()
  );
  await requestBoundary.settle();
  await assertExpectedOrigin(cdp, expectedOrigin, sessionId, requestBoundary);
}

function hostResolverRules(allowedHosts) {
  return `MAP * ~NOTFOUND, ${allowedHosts.map(host => `EXCLUDE ${host}`).join(", ")}`;
}

async function stopBrowserAndRemoveProfile(child, profile) {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once("exit", resolve));
    child.kill("SIGKILL");
    await Promise.race([exited, delay(2_000)]);
  }

  // Chrome can release the process before its profile helpers release every
  // directory entry. Retry the isolated profile removal instead of letting an
  // ENOTEMPTY race replace a valid observation with a generic browser failure.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(profile, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = String(error?.code ?? "");
      if (!["EBUSY", "ENOTEMPTY", "EPERM"].includes(code) || attempt === 4) {
        throw new Error("browser_profile_cleanup_failed");
      }
      await delay(100 * (attempt + 1));
    }
  }
}

export async function checkBrowserAccess(config) {
  // Keep this guard here as well as in the observer so direct callers cannot
  // start Chrome/CDP for an unbound target.
  assertBrowserStagingTarget(config);
  const profile = mkdtempSync(join(tmpdir(), "dropos-browser-"));
  const child = spawn(chromePath(), [
    "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-sync",
    "--disable-background-networking", "--disable-extensions", "--disable-dev-shm-usage",
    "--disable-component-update", "--disable-domain-reliability", "--disable-default-apps",
    "--disable-client-side-phishing-detection", "--metrics-recording-only", "--no-pings",
    "--dns-prefetch-disable", "--disable-preconnect",
    "--disable-features=Prerender2,SpeculationRulesPrefetch,WebTransport,DnsOverHttpsUpgrade",
    `--host-resolver-rules=${hostResolverRules(config.networkAllowedHosts)}`,
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"
  ], { stdio: "ignore" });
  let cdp;
  let requestBoundary;
  let currentStage = "chrome_start";
  try {
    currentStage = "debug_endpoint";
    const portFile = join(profile, "DevToolsActivePort");
    const [port, browserPath] = await waitFor(async () => {
      const lines = readFileSync(portFile, "utf8").trim().split("\n");
      return lines.length >= 2 ? lines : null;
    }, config.browserTimeoutMs);
    if (!/^\d+$/.test(port) || !browserPath.startsWith("/devtools/browser/")) {
      throw new Error("browser_debug_endpoint_invalid");
    }
    currentStage = "cdp_connect";
    cdp = cdpSocket(`ws://127.0.0.1:${port}${browserPath}`);
    await cdp.open;
    currentStage = "network_boundary";
    requestBoundary = await installBrowserRequestBoundary(cdp, config);
    currentStage = "page_session";
    const { sessionId } = await requestBoundary.waitForPageSession(config.browserTimeoutMs);
    await requestBoundary.settle();

    const stagingOrigin = new URL(config.browserLoginUrl).origin;
    currentStage = "login_navigation";
    await navigate(cdp, config.browserLoginUrl, stagingOrigin, config.browserTimeoutMs, sessionId, requestBoundary);
    currentStage = "login_form";
    await waitFor(
      () => evaluate(cdp, expression(config.emailSelector, ""), sessionId),
      config.browserTimeoutMs,
      () => requestBoundary.assertSafe()
    );
    const setValue = value =>
      `el.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)}); ` +
      `el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}))`;
    await assertExpectedOrigin(cdp, stagingOrigin, sessionId, requestBoundary);
    await evaluate(cdp, expression(config.emailSelector, setValue(config.testEmail)), sessionId);
    await assertExpectedOrigin(cdp, stagingOrigin, sessionId, requestBoundary);
    await evaluate(cdp, expression(config.passwordSelector, setValue(config.testPassword)), sessionId);
    await assertExpectedOrigin(cdp, stagingOrigin, sessionId, requestBoundary);
    currentStage = "login_submission";
    await evaluate(cdp, expression(config.submitSelector, "el.click()"), sessionId);
    // The login is a server action. A fixed sleep can race its signed response
    // and navigate away before the secure cookies are committed, especially on
    // a cold staging function. Wait for the same-origin authenticated redirect
    // instead, and keep the fail-closed request boundary active while waiting.
    currentStage = "authenticated_redirect";
    await waitForAuthenticatedNavigation(
      cdp,
      config.browserLoginUrl,
      stagingOrigin,
      config.browserTimeoutMs,
      sessionId,
      requestBoundary
    );
    currentStage = "access_navigation";
    await navigate(cdp, config.browserAccessUrl, stagingOrigin, config.browserTimeoutMs, sessionId, requestBoundary);
    currentStage = "access_marker";
    const accessGranted = Boolean(await waitFor(
      () => evaluate(cdp, expression(config.successSelector, ""), sessionId),
      config.browserTimeoutMs,
      () => requestBoundary.assertSafe()
    ).catch(() => false));
    await requestBoundary.settle();
    requestBoundary.assertSafe();
    await assertExpectedOrigin(cdp, stagingOrigin, sessionId, requestBoundary);
    return accessGranted;
  } catch (error) {
    const code = String(error?.message ?? "browser_failed")
      .slice(0, 80)
      .replace(/[^a-zA-Z0-9_.:-]/g, "_");
    throw new Error(`browser_${currentStage}_${code}`);
  } finally {
    requestBoundary?.close();
    cdp?.close();
    await stopBrowserAndRemoveProfile(child, profile);
  }
}
