const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const RPC = /^[a-z][a-z0-9_]{0,62}$/;
const SUPABASE_SCHEMA = /^[a-z_][a-z0-9_]{0,62}$/;
const STRIPE_CUSTOMER = /^cus_[A-Za-z0-9]{8,}$/;
const STRIPE_PRICE = /^price_[A-Za-z0-9]{8,}$/;
const STRIPE_RESTRICTED_KEY = {
  staging: /^rk_test_[A-Za-z0-9]{16,}$/,
  production: /^rk_live_[A-Za-z0-9]{16,}$/
};
const TARGET_ENVIRONMENT = /^(staging|production)$/;
const SUPABASE_PUBLISHABLE_KEY = /^sb_publishable_[A-Za-z0-9_-]{16,}$/;
const SUPABASE_PROJECT_REF = /^[a-z0-9]{20}$/;
const PRODUCTION_SUPABASE_PROJECT_REF = "zuvxiosuhqpsczjimwwl";
const DNS_HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PRODUCTION_INGRESS_HOSTS = new Set([
  "www.dropos.co",
  "dropos.co",
  "drop-os-opal.vercel.app"
]);
const PRODUCTION_DROP_OS_HOSTS = PRODUCTION_INGRESS_HOSTS;

export class RunnerConfigurationError extends Error {
  constructor(code) {
    super(code);
    this.name = "RunnerConfigurationError";
    this.code = code;
  }
}

function required(env, name) {
  const value = String(env[name] ?? "").trim();
  if (!value) throw new RunnerConfigurationError(`configuration_missing:${name.toLowerCase()}`);
  return value;
}

/**
 * Read the current name, falling back to the one it replaced.
 *
 * Three inputs were called `staging-*` when staging was the only thing this could
 * check. They now describe the environment a customer chose, so the names dropped
 * the word — but a workflow installed against an older pinned commit still sends
 * the old ones, and moving a pin should never break a working check. New names win
 * where both are present.
 */
function requiredEither(env, name, previousName) {
  const value = String(env[name] ?? "").trim() || String(env[previousName] ?? "").trim();
  if (!value) throw new RunnerConfigurationError(`configuration_missing:${name.toLowerCase()}`);
  return value;
}

function httpsUrl(value, code) {
  let url;
  try { url = new URL(value); } catch { throw new RunnerConfigurationError(code); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new RunnerConfigurationError(code);
  }
  return url.toString();
}

function boundedInteger(value, minimum, maximum, code) {
  if (!/^\d+$/.test(value)) throw new RunnerConfigurationError(code);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RunnerConfigurationError(code);
  }
  return parsed;
}

function matching(value, pattern, code) {
  if (!pattern.test(value)) throw new RunnerConfigurationError(code);
  return value;
}

function exactHostnameAllowlist(value, code) {
  const hosts = value.split(",").map(host => host.trim().toLowerCase());
  if (hosts.length < 1 || hosts.length > 20 || hosts.some(host => !DNS_HOSTNAME.test(host))) {
    throw new RunnerConfigurationError(code);
  }
  if (new Set(hosts).size !== hosts.length) {
    throw new RunnerConfigurationError(code);
  }
  return Object.freeze(hosts);
}

const ingressHosts = value => exactHostnameAllowlist(value, "ingress_host_allowlist_invalid");
const networkHosts = value => exactHostnameAllowlist(value, "network_host_allowlist_invalid");

function productionHostRefused(host) {
  return PRODUCTION_DROP_OS_HOSTS.has(host) || host.includes(PRODUCTION_SUPABASE_PROJECT_REF);
}

function parsedHttpsUrl(value, code) {
  let url;
  try { url = new URL(value); } catch { throw new RunnerConfigurationError(code); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new RunnerConfigurationError(code);
  }
  return url;
}

function assertKnownEnvironment(config) {
  if (!TARGET_ENVIRONMENT.test(String(config.targetEnvironment ?? ""))) {
    throw new RunnerConfigurationError("target_environment_invalid");
  }
  return config.targetEnvironment;
}

/**
 * The billing credential, held to the mode of the environment being checked.
 *
 * Both modes require a RESTRICTED key. `rk_` is the whole point: a restricted key
 * can be scoped to reading subscriptions and nothing else, and a full `sk_` secret
 * is refused in either environment. Checking production means holding a live
 * credential in the customer's own GitHub environment, so the narrowest possible
 * one is the only acceptable shape.
 */
export function assertStripeTarget(config) {
  const environment = assertKnownEnvironment(config);
  const key = String(config.stripeKey ?? "");
  if (/^sk_/.test(key)) throw new RunnerConfigurationError("stripe_key_not_restricted");
  if (!STRIPE_RESTRICTED_KEY[environment].test(key)) {
    throw new RunnerConfigurationError(
      environment === "production" ? "stripe_key_not_live_restricted" : "stripe_key_not_test_restricted"
    );
  }
}

/** Retained name, unchanged meaning for staging callers. */
export const assertStripeStagingTarget = assertStripeTarget;

export function assertIngressStagingTarget(config) {
  assertKnownEnvironment(config);
  const allowedHosts = config.ingressAllowedHosts;
  if (!Array.isArray(allowedHosts) || allowedHosts.length < 1 || allowedHosts.length > 20 ||
      allowedHosts.some(host => typeof host !== "string" || !DNS_HOSTNAME.test(host) || host !== host.toLowerCase()) ||
      new Set(allowedHosts).size !== allowedHosts.length) {
    throw new RunnerConfigurationError("ingress_host_allowlist_invalid");
  }
  const endpoint = parsedHttpsUrl(String(config.endpoint ?? ""), "endpoint_invalid");
  if (productionHostRefused(endpoint.hostname) || allowedHosts.some(productionHostRefused)) {
    throw new RunnerConfigurationError("production_ingress_host_refused");
  }
  if (endpoint.port || endpoint.pathname !== "/api/truth/runs" || endpoint.search) {
    throw new RunnerConfigurationError("ingress_endpoint_invalid");
  }
  if (!allowedHosts.includes(endpoint.hostname)) {
    throw new RunnerConfigurationError("ingress_target_not_allowlisted");
  }
}

export function assertSupabaseStagingTarget(config) {
  assertKnownEnvironment(config);
  const projectRef = String(config.stagingSupabaseProjectRef ?? "");
  if (!SUPABASE_PROJECT_REF.test(projectRef)) {
    throw new RunnerConfigurationError("supabase_project_ref_invalid");
  }
  const url = parsedHttpsUrl(String(config.supabaseUrl ?? ""), "supabase_url_invalid");
  if (projectRef === PRODUCTION_SUPABASE_PROJECT_REF || url.hostname === `${PRODUCTION_SUPABASE_PROJECT_REF}.supabase.co`) {
    throw new RunnerConfigurationError("production_supabase_project_ref_refused");
  }
  if (url.hostname !== `${projectRef}.supabase.co` || url.port || url.pathname !== "/" || url.search) {
    throw new RunnerConfigurationError("supabase_url_not_staging_project");
  }
}

export function assertBrowserStagingTarget(config) {
  assertKnownEnvironment(config);
  const allowedHosts = config.networkAllowedHosts;
  if (!Array.isArray(allowedHosts) || allowedHosts.length < 1 || allowedHosts.length > 20 ||
      allowedHosts.some(host => typeof host !== "string" || !DNS_HOSTNAME.test(host) || host !== host.toLowerCase()) ||
      new Set(allowedHosts).size !== allowedHosts.length) {
    throw new RunnerConfigurationError("network_host_allowlist_invalid");
  }
  if (allowedHosts.some(productionHostRefused)) {
    throw new RunnerConfigurationError("production_network_host_refused");
  }
  const login = parsedHttpsUrl(String(config.browserLoginUrl ?? ""), "browser_login_url_invalid");
  const access = parsedHttpsUrl(String(config.browserAccessUrl ?? ""), "browser_access_url_invalid");
  if (productionHostRefused(login.hostname) || productionHostRefused(access.hostname)) {
    throw new RunnerConfigurationError("production_browser_host_refused");
  }
  if (login.origin !== access.origin) {
    throw new RunnerConfigurationError("browser_targets_not_same_origin");
  }
  if (login.port || !allowedHosts.includes(login.hostname)) {
    throw new RunnerConfigurationError("browser_target_not_allowlisted");
  }
  const projectRef = String(config.stagingSupabaseProjectRef ?? "");
  if (!SUPABASE_PROJECT_REF.test(projectRef) || projectRef === PRODUCTION_SUPABASE_PROJECT_REF) {
    throw new RunnerConfigurationError("supabase_project_ref_invalid");
  }
  if (!allowedHosts.includes(`${projectRef}.supabase.co`)) {
    throw new RunnerConfigurationError("network_host_allowlist_incomplete");
  }
}

export function assertRunnerStagingTargets(config) {
  assertIngressStagingTarget(config);
  assertStripeStagingTarget(config);
  assertSupabaseStagingTarget(config);
  assertBrowserStagingTarget(config);
}

export function readRunnerConfig(env = process.env) {
  // The browser observer opens a CDP connection with the GLOBAL WebSocket, which is
  // only enabled by default from Node 22. Accepting Node 20 here let the run pass
  // configuration, contact Stripe and the entitlement RPC, and then fail inside the
  // browser check with "WebSocket is not defined" — a confusing failure, after the
  // customer's providers had already been called. The floor now matches what the
  // runner actually needs, and it is refused before any network call.
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < 22) throw new RunnerConfigurationError("node_22_required");

  const proposedPredecessor = String(env.DROP_OS_SUPERSEDES_RUN_ID ?? "").trim();

  const config = {
    // Opt-in, and never inferred. A workflow that says nothing is a staging
    // workflow, so no installation starts checking a live application by accident.
    targetEnvironment: matching(required(env, "DROP_OS_TARGET_ENVIRONMENT"), TARGET_ENVIRONMENT, "target_environment_invalid"),
    endpoint: httpsUrl(required(env, "DROP_OS_ENDPOINT"), "endpoint_invalid"),
    ingressAllowedHosts: ingressHosts(requiredEither(env, "DROP_OS_INGRESS_HOSTS", "DROP_OS_STAGING_INGRESS_HOSTS")),
    projectId: matching(required(env, "DROP_OS_PROJECT_ID"), ID, "project_id_invalid"),
    contractId: matching(required(env, "DROP_OS_CONTRACT_ID"), ID, "contract_id_invalid"),
    contractVersion: boundedInteger(required(env, "DROP_OS_CONTRACT_VERSION"), 1, 1_000_000, "contract_version_invalid"),
    specHash: matching(required(env, "DROP_OS_SPEC_HASH"), SHA256, "spec_hash_invalid"),
    runKind: proposedPredecessor ? "rerun" : "initial",
    supersedesRunId: proposedPredecessor
      ? matching(proposedPredecessor, UUID, "supersedes_run_id_invalid")
      : undefined,
    convergenceAttempt: 0,
    convergenceRetries: boundedInteger(
      String(env.DROP_OS_CONVERGENCE_RETRIES ?? "2").trim(),
      0,
      4,
      "convergence_retries_invalid"
    ),
    convergenceMaxWaitMs: boundedInteger(
      String(env.DROP_OS_CONVERGENCE_MAX_WAIT_MS ?? "120000").trim(),
      1_000,
      300_000,
      "convergence_wait_invalid"
    ),
    commitSha: matching(required(env, "GITHUB_SHA"), SHA1, "github_sha_invalid"),
    githubRunId: matching(required(env, "GITHUB_RUN_ID"), /^\d{1,30}$/, "github_run_id_invalid"),
    githubRunAttempt: matching(required(env, "GITHUB_RUN_ATTEMPT"), /^\d{1,10}$/, "github_run_attempt_invalid"),
    stripeCustomerId: matching(required(env, "DROP_OS_STRIPE_CUSTOMER_ID"), STRIPE_CUSTOMER, "stripe_customer_id_invalid"),
    stripePriceId: matching(required(env, "DROP_OS_STRIPE_PRICE_ID"), STRIPE_PRICE, "stripe_price_id_invalid"),
    // Held to the mode of the environment being checked, at read time as well as
    // before the first Stripe call, so a live key can never reach a staging check
    // and a test key can never be mistaken for evidence about a live application.
    stripeKey: matching(
      required(env, "STRIPE_RESTRICTED_KEY"),
      STRIPE_RESTRICTED_KEY[String(env.DROP_OS_TARGET_ENVIRONMENT ?? "").trim()] ?? STRIPE_RESTRICTED_KEY.staging,
      String(env.DROP_OS_TARGET_ENVIRONMENT ?? "").trim() === "production"
        ? "stripe_key_not_live_restricted"
        : "stripe_key_not_test_restricted"
    ),
    stagingSupabaseProjectRef: matching(requiredEither(env, "DROP_OS_SUPABASE_PROJECT_REF", "DROP_OS_STAGING_SUPABASE_PROJECT_REF"), SUPABASE_PROJECT_REF, "supabase_project_ref_invalid"),
    supabaseUrl: httpsUrl(required(env, "DROP_OS_SUPABASE_URL"), "supabase_url_invalid"),
    supabaseRpc: matching(required(env, "DROP_OS_SUPABASE_RPC"), RPC, "supabase_rpc_invalid"),
    supabaseSchema: matching(String(env.DROP_OS_SUPABASE_SCHEMA ?? "public").trim(), SUPABASE_SCHEMA, "supabase_schema_invalid"),
    supabaseKey: matching(required(env, "SUPABASE_PUBLISHABLE_KEY"), SUPABASE_PUBLISHABLE_KEY, "supabase_key_not_publishable"),
    testEmail: required(env, "DROP_OS_TEST_EMAIL"),
    testPassword: required(env, "DROP_OS_TEST_PASSWORD"),
    browserLoginUrl: httpsUrl(required(env, "DROP_OS_BROWSER_LOGIN_URL"), "browser_login_url_invalid"),
    browserAccessUrl: httpsUrl(required(env, "DROP_OS_BROWSER_ACCESS_URL"), "browser_access_url_invalid"),
    networkAllowedHosts: networkHosts(requiredEither(env, "DROP_OS_NETWORK_HOSTS", "DROP_OS_STAGING_NETWORK_HOSTS")),
    emailSelector: required(env, "DROP_OS_EMAIL_SELECTOR"),
    passwordSelector: required(env, "DROP_OS_PASSWORD_SELECTOR"),
    submitSelector: required(env, "DROP_OS_SUBMIT_SELECTOR"),
    successSelector: required(env, "DROP_OS_SUCCESS_SELECTOR"),
    browserTimeoutMs: boundedInteger(required(env, "DROP_OS_BROWSER_TIMEOUT_MS"), 1_000, 120_000, "browser_timeout_invalid")
  };
  for (const selector of [config.emailSelector, config.passwordSelector, config.submitSelector, config.successSelector]) {
    if (selector.length > 300 || /[\r\n\0]/.test(selector)) throw new RunnerConfigurationError("browser_selector_invalid");
  }
  assertRunnerStagingTargets(config);
  return Object.freeze(config);
}
