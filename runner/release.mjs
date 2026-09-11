import { readBoundedJson, safeFetch } from "./http.mjs";
import { RunnerConfigurationError } from "./config.mjs";

/**
 * Bind what the browser observed to the deployment being reported on.
 *
 * A deployment event proves that a commit was deployed. The chained run proves the
 * branch and the commit. But the browser check visits a stable application URL, and
 * nothing in any of that proves the application answering at that URL was serving
 * THAT commit at THAT moment — an older release can still be live, or a newer one
 * can replace it half way through. A verdict that says "at commit X, paid access
 * works" would then be describing a release nobody asked about, which is exactly
 * the kind of confident wrongness this product exists to prevent.
 *
 * So the customer points `release-endpoint` at something their application already
 * serves that names its own commit, and this reads it before the observations and
 * again after them. Both readings must be the commit under check. A release that
 * changed mid-check fails the second reading and the run is refused rather than
 * reported.
 */
export async function readServedCommit(config, fetchImpl = fetch) {
  const endpoint = config.releaseEndpoint;
  if (!endpoint) return null;
  const response = await safeFetch(fetchImpl)(endpoint, {
    method: "GET",
    redirect: "error",
    cache: "no-store",
    headers: { accept: "application/json" }
  }).catch(() => null);
  if (!response || !response.ok) throw new RunnerConfigurationError("release_endpoint_unreadable");

  const payload = await readBoundedJson(response).catch(() => null);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new RunnerConfigurationError("release_response_invalid");
  }
  const served = payload[config.releaseCommitField];
  if (typeof served !== "string" || !/^[0-9a-f]{40}$/.test(served)) {
    throw new RunnerConfigurationError("release_commit_invalid");
  }
  return served;
}

/** Refuse unless the application is serving the exact commit being reported on. */
export async function assertServingAdmittedCommit(config, fetchImpl = fetch) {
  const served = await readServedCommit(config, fetchImpl);
  if (served === null) return false;
  if (served !== config.commitSha) {
    throw new RunnerConfigurationError("release_not_serving_admitted_commit");
  }
  return true;
}
