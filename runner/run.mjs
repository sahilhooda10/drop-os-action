import { createHash } from "node:crypto";
import { readBoundedJson, safeFetch } from "./http.mjs";
import { assertIngressStagingTarget } from "./config.mjs";

export const OIDC_AUDIENCE = "dropos-truth-v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function githubOidcRequestUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("github_oidc_url_invalid");
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".actions.githubusercontent.com") ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  ) {
    throw new Error("github_oidc_url_invalid");
  }
  return url;
}

export async function requestOidcToken(env = process.env, fetchImpl = fetch) {
  const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) throw new Error("github_oidc_unavailable");
  const url = githubOidcRequestUrl(requestUrl);
  url.searchParams.set("audience", OIDC_AUDIENCE);
  const response = await safeFetch(fetchImpl)(url, {
    redirect: "error",
    headers: { Authorization: `Bearer ${requestToken}`, Accept: "application/json" }
  });
  if (!response.ok) throw new Error("github_oidc_refused");
  const payload = await readBoundedJson(response, 16_384);
  if (!payload || typeof payload.value !== "string" || payload.value.length < 100) {
    throw new Error("github_oidc_invalid");
  }
  return payload.value;
}

export function claimedVerdict(observers) {
  const stripeObserver = observers.find(o => o.subsystem === "stripe");
  const entitlementObserver = observers.find(o => o.subsystem === "app_entitlement");
  const browserObserver = observers.find(o => o.subsystem === "browser");
  const stripe = stripeObserver?.outcome === "observed"
    ? stripeObserver.facts.subscription_active
    : undefined;
  const entitlement = entitlementObserver?.outcome === "observed"
    ? entitlementObserver.facts.plan_active
    : undefined;
  const browser = browserObserver?.outcome === "observed"
    ? browserObserver.facts.access_granted
    : undefined;

  // Match the server's fail-safe ordering: a settled disagreement between two
  // readable neighbours remains a contradiction even when an unrelated third
  // observer is unavailable. Otherwise a browser outage could hide a proven
  // Stripe-to-entitlement defect and make the runner's claim disagree with the
  // server-owned verdict.
  if (typeof stripe === "boolean" && typeof entitlement === "boolean" && stripe !== entitlement) {
    return "CONTRADICTION";
  }
  if (typeof entitlement === "boolean" && typeof browser === "boolean" && entitlement !== browser) {
    return "CONTRADICTION";
  }
  if (observers.some(observer => observer.outcome !== "observed")) return "COULD_NOT_VERIFY";
  if (![stripe, entitlement, browser].every(value => typeof value === "boolean")) {
    return "COULD_NOT_VERIFY";
  }
  // The V1 contract verifies paid access for a known active subscription. An
  // all-false chain means that precondition was not established, not PASS.
  if (stripe !== true) return "COULD_NOT_VERIFY";
  return "PASS";
}

/**
 * A digest over the subject this check is configured against.
 *
 * The server pins it the first time it sees one and refuses a different one after
 * that, so a check silently repointed at another customer, price, database or page
 * is rejected rather than quietly producing a verdict about somebody else.
 *
 * It is a digest, so none of these identifiers leaves the runner. And it proves
 * exactly one thing: that this check is configured the same way the last one was.
 * It does NOT prove that the billing customer and the application account are the
 * same person. Nothing in V1 does, and the three observers agreeing does not
 * either — they can agree perfectly about two different people.
 */
export function subjectDigest(config) {
  const raw = String(config.browserAccessUrl ?? "");
  let page = raw;
  try {
    const access = new URL(raw);
    // Origin and path only: a query string or fragment is not part of who is
    // being checked, and including one would break the pin on a harmless edit.
    page = `${access.origin}${access.pathname}`;
  } catch { /* an unparseable value is digested as given */ }
  const part = value => String(value ?? "");
  return createHash("sha256").update([
    part(config.targetEnvironment),
    part(config.stripeCustomerId),
    part(config.stripePriceId),
    part(config.stagingSupabaseProjectRef),
    part(config.supabaseSchema ?? "public"),
    part(config.supabaseRpc),
    page
  ].join("\n"), "utf8").digest("hex");
}

export function buildEnvelope(config, observers, startedAt, finishedAt) {
  const verdict = claimedVerdict(observers);
  const convergenceAttempt = Number(config.convergenceAttempt ?? 0);
  if (!Number.isInteger(convergenceAttempt) || convergenceAttempt < 0 || convergenceAttempt > 4) {
    throw new Error("convergence_attempt_invalid");
  }
  return {
    projectId: config.projectId,
    contractId: config.contractId,
    contractVersion: config.contractVersion,
    specHash: config.specHash,
    runId: `${config.githubRunId}.${config.githubRunAttempt}${convergenceAttempt ? `.c${convergenceAttempt}` : ""}`,
    kind: config.runKind,
    ...(config.supersedesRunId ? { supersedesRunId: config.supersedesRunId } : {}),
    commitSha: config.commitSha,
    targetEnvironment: config.targetEnvironment,
    subjectDigest: subjectDigest(config),
    verdict,
    reasons: verdict === "PASS" ? ["all_assertions_held"] : [verdict === "CONTRADICTION" ? "observer_values_disagree" : "observer_unavailable"],
    observers,
    startedAt,
    finishedAt,
    diagnosticCodes: observers.filter(o => o.outcome !== "observed").map(o => `observer_unavailable.${o.subsystem}`)
  };
}

export async function submitEnvelope(config, envelope, token, fetchImpl = fetch) {
  // Revalidate at the credential-bearing call boundary. The main preflight
  // already does this, but a direct caller must not bypass staging isolation.
  assertIngressStagingTarget(config);
  const response = await safeFetch(fetchImpl)(config.endpoint, {
    method: "POST",
    redirect: "error",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", Accept: "application/json" },
    body: JSON.stringify(envelope)
  });
  if (!response.ok) throw new Error(`dropos_ingestion_refused_${response.status}`);
  const result = await readBoundedJson(response, 16_384);
  if (
    !result ||
    !UUID.test(String(result.runId ?? "")) ||
    !["PASS", "CONTRADICTION", "COULD_NOT_VERIFY"].includes(result.verdict) ||
    !["pending_convergence", "final", "superseded"].includes(result.lifecycleStatus) ||
    !(
      result.convergenceDueAt === null ||
      (typeof result.convergenceDueAt === "string" && Number.isFinite(Date.parse(result.convergenceDueAt)))
    )
  ) {
    throw new Error("dropos_response_invalid");
  }
  return result;
}

export async function drainNotifications(config, token, runId, fetchImpl = fetch) {
  assertIngressStagingTarget(config);
  const endpoint = new URL(config.endpoint);
  endpoint.pathname = "/api/truth/notifications";
  endpoint.search = "";
  endpoint.hash = "";
  const response = await safeFetch(fetchImpl)(endpoint, {
    method: "POST",
    redirect: "error",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ runId })
  });
  if (!response.ok) throw new Error(`dropos_notification_refused_${response.status}`);
  const result = await readBoundedJson(response, 8_192);
  const counts = [result?.sent, result?.pending, result?.delayed, result?.failed];
  const current = result?.current;
  if (
    !result ||
    typeof result.providerConfigured !== "boolean" ||
    counts.some(value => !Number.isInteger(value) || value < 0 || value > 10_000) ||
    !(
      current === null ||
      (
        current &&
        ["incident", "recovery"].includes(current.kind) &&
        ["pending", "delivering", "retry_scheduled", "sent", "failed"].includes(current.status) &&
        Number.isInteger(current.attemptCount) && current.attemptCount >= 0 && current.attemptCount <= 8
      )
    )
  ) {
    throw new Error("dropos_notification_response_invalid");
  }
  return result;
}
