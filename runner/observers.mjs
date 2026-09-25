import { createHash } from "node:crypto";
import { readBoundedJson, safeFetch } from "./http.mjs";
import {
  assertBrowserStagingTarget,
  assertRunnerStagingTargets,
  assertStripeStagingTarget,
  assertSupabaseStagingTarget
} from "./config.mjs";

const observedAt = () => new Date().toISOString();
const unavailable = (subsystem, code) => ({
  subsystem, outcome: "unavailable", observedAt: observedAt(), facts: {}, evidence: [], unavailableReason: code
});

export async function observeStripe(config, dependencies = {}) {
  assertStripeStagingTarget(config);
  const fetcher = safeFetch(dependencies.fetchImpl ?? fetch);
  try {
    const query = new URLSearchParams({ customer: config.stripeCustomerId, status: "all", limit: "100" });
    const response = await fetcher(`https://api.stripe.com/v1/subscriptions?${query}`, {
      redirect: "error",
      headers: { Authorization: `Bearer ${config.stripeKey}`, Accept: "application/json" }
    });
    if (!response.ok) return unavailable("stripe", `stripe_http_${response.status}`);
    const payload = await readBoundedJson(response);
    if (!payload || !Array.isArray(payload.data)) return unavailable("stripe", "stripe_response_invalid");
    const matchesPrice = subscription =>
      Array.isArray(subscription?.items?.data) &&
      subscription.items.data.some(item => item?.price?.id === config.stripePriceId);
    const active = payload.data.some(subscription =>
      ["active", "trialing"].includes(subscription?.status) && matchesPrice(subscription)
    );
    // The paid PERIOD, which is wider than "paying this instant" but is NOT open
    // ended. A past-due card retry and a cancelled subscription both keep access
    // only until the period the customer actually paid for runs out, so each needs
    // a period end in the future. Without that bound a subscription could sit in
    // past_due forever and grant access forever, which is the failure this contract
    // exists to catch.
    const nowSeconds = Math.floor(Date.now() / 1000);
    // Stripe moved current_period_end from the subscription onto its items in API
    // version 2025-03-31. Which one arrives depends on the customer's account
    // version, so read both: otherwise the same app could get opposite verdicts on
    // two Stripe accounts.
    const periodEnd = subscription => {
      if (Number.isFinite(subscription?.current_period_end)) return subscription.current_period_end;
      const ends = (Array.isArray(subscription?.items?.data) ? subscription.items.data : [])
        .filter(item => item?.price?.id === config.stripePriceId)
        .map(item => item?.current_period_end)
        .filter(Number.isFinite);
      return ends.length ? Math.max(...ends) : Number.NaN;
    };
    const withinPaidPeriod = subscription => periodEnd(subscription) > nowSeconds;
    const periodActive = payload.data.some(subscription => matchesPrice(subscription) && (
      ["active", "trialing"].includes(subscription?.status) ||
      (["past_due", "canceled"].includes(subscription?.status) && withinPaidPeriod(subscription))
    ));
    // A readable list is an observation, including a readable "no paid period".
    // Only a provider failure is unavailable; the contract states the precondition
    // that stops an all-false world reading as a clean PASS.
    return {
      subsystem: "stripe", outcome: "observed", observedAt: observedAt(),
      facts: { subscription_active: active, entitlement_period_active: periodActive },
      evidence: []
    };
  } catch { return unavailable("stripe", "stripe_request_failed"); }
}

async function signIn(config, fetcher) {
  const url = new URL("/auth/v1/token", config.supabaseUrl);
  url.searchParams.set("grant_type", "password");
  const response = await fetcher(url, {
    method: "POST",
    redirect: "error",
    headers: { apikey: config.supabaseKey, "content-type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email: config.testEmail, password: config.testPassword })
  });
  if (!response.ok) throw new Error(`auth_http_${response.status}`);
  const payload = await readBoundedJson(response);
  if (!payload || typeof payload.access_token !== "string" || payload.access_token.length < 20) {
    throw new Error("auth_response_invalid");
  }
  return payload.access_token;
}

export async function observeEntitlement(config, dependencies = {}) {
  assertSupabaseStagingTarget(config);
  const fetcher = safeFetch(dependencies.fetchImpl ?? fetch);
  try {
    const accessToken = await signIn(config, fetcher);
    const url = new URL(`/rest/v1/rpc/${config.supabaseRpc}`, config.supabaseUrl);
    const response = await fetcher(url, {
      method: "POST",
      redirect: "error",
      headers: {
        apikey: config.supabaseKey,
        Authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "Content-Profile": config.supabaseSchema ?? "public",
        "Accept-Profile": config.supabaseSchema ?? "public",
        Accept: "application/json"
      },
      body: "{}"
    });
    if (!response.ok) {
      const hint = {
        404: `Supabase could not find ${config.supabaseRpc} in the ${config.supabaseSchema ?? "public"} schema. Check supabase-rpc and supabase-schema, and that the schema is exposed to the API.`,
        401: `The signed-in test account may not call ${config.supabaseRpc}. Grant execute on it to authenticated.`,
        403: `The signed-in test account may not call ${config.supabaseRpc}. Grant execute on it to authenticated.`
      }[response.status];
      if (hint) process.stdout.write(`::warning title=DROP OS: entitlement function refused::${hint}\n`);
      return unavailable("app_entitlement", `entitlement_http_${response.status}`);
    }
    const payload = await readBoundedJson(response);
    const row = Array.isArray(payload) ? payload[0] : payload;
    if (!row || typeof row.plan_active !== "boolean" || Object.keys(row).some(key => key !== "plan_active")) {
      return unavailable("app_entitlement", "entitlement_response_invalid");
    }
    return {
      subsystem: "app_entitlement", outcome: "observed", observedAt: observedAt(),
      facts: { plan_active: row.plan_active }, evidence: []
    };
  } catch (error) {
    // The code sent to DROP OS stays the same; the customer's own log says which
    // of their inputs to look at, because "request failed" covered a wrong password,
    // an unconfirmed email and an unreachable project alike.
    const code = String(error?.message ?? "");
    if (/^auth_http_4\d\d$/.test(code)) {
      process.stdout.write(`::warning title=DROP OS: the test account could not sign in::Supabase refused the sign-in (${code.slice(5).replace("_", " ").toUpperCase()}). Check DROP_OS_TEST_EMAIL and DROP_OS_TEST_PASSWORD, that the account's email is confirmed, and that DROP_OS_SUPABASE_PUBLISHABLE_KEY belongs to this Supabase project.\n`);
    }
    return unavailable("app_entitlement", "entitlement_request_failed");
  }
}

export function browserEvidence(accessGranted, capturedAt = observedAt()) {
  const bytes = Buffer.from(JSON.stringify({ access_granted: accessGranted, kind: "selector_check" }));
  return {
    id: "browser_selector_check",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    mediaType: "application/json",
    byteSize: bytes.byteLength,
    capturedAt,
    redaction: "none_required"
  };
}

export async function observeBrowser(config, dependencies = {}) {
  assertBrowserStagingTarget(config);
  const capturedAt = observedAt();
  try {
    const accessGranted = await dependencies.checkBrowser(config);
    if (typeof accessGranted !== "boolean") throw new Error("browser_result_invalid");
    return {
      subsystem: "browser", outcome: "observed", observedAt: capturedAt,
      facts: { access_granted: accessGranted }, evidence: [browserEvidence(accessGranted, capturedAt)]
    };
  } catch (error) {
    // Browser stages emit only bounded machine codes. Preserve those codes so
    // operators can distinguish launch, login and egress-boundary failures
    // without exposing a URL, credential or provider response.
    const code = String(error?.message ?? "");
    const reason = /^browser_[a-z0-9_.:-]{1,180}$/i.test(code)
      ? code
      : "browser_check_failed";
    return unavailable("browser", reason);
  }
}

export async function collectObservations(config, dependencies) {
  // Refuse the complete target set before starting any provider or browser work.
  assertRunnerStagingTargets(config);
  // Parallel calls reduce CI time. Each adapter receives only the configuration it needs.
  return Promise.all([
    observeStripe(config, dependencies),
    observeEntitlement(config, dependencies),
    observeBrowser(config, dependencies)
  ]);
}
