import { collectObservations } from "./observers.mjs";
import { checkBrowserAccess } from "./browser.mjs";
import { buildEnvelope, drainNotifications, submitEnvelope } from "./run.mjs";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Execute one complete deployment check, including server-clock convergence
 * and the delivery state for the final run's durable notification.
 *
 * Dependencies are injectable solely so the state machine can be tested
 * without provider, browser, email, or database access.
 */
export async function executePaidAccessCheck(config, token, dependencies = {}) {
  const now = dependencies.now ?? (() => Date.now());
  const wait = dependencies.wait ?? sleep;
  const collect = dependencies.collectObservations ?? collectObservations;
  const submit = dependencies.submitEnvelope ?? submitEnvelope;
  const drain = dependencies.drainNotifications ?? drainNotifications;
  const browser = dependencies.checkBrowser ?? checkBrowserAccess;
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const retryWaits = dependencies.notificationRetryWaits ?? [0, 2_200, 10_200, 60_200];
  const started = now();
  let attemptConfig = config;
  let result;
  let observers = [];

  for (let attempt = 0; attempt <= config.convergenceRetries; attempt += 1) {
    const startedAt = new Date(now()).toISOString();
    observers = await collect(attemptConfig, { fetchImpl, checkBrowser: browser });
    dependencies.onObservers?.(observers, attempt);
    const envelope = buildEnvelope(attemptConfig, observers, startedAt, new Date(now()).toISOString());
    result = await submit(attemptConfig, envelope, token, fetchImpl);
    dependencies.onResult?.(result, attempt);
    if (result.lifecycleStatus !== "pending_convergence") break;
    if (attempt === config.convergenceRetries) break;

    const dueAt = Date.parse(String(result.convergenceDueAt ?? ""));
    const waitMs = dueAt - now();
    const elapsedAfterWait = now() - started + Math.max(waitMs, 0);
    if (!Number.isFinite(dueAt) || waitMs < -5_000 || elapsedAfterWait > config.convergenceMaxWaitMs) {
      throw new Error("convergence_deadline_invalid");
    }
    dependencies.onConvergenceWait?.(Math.max(waitMs, 0), attempt);
    if (waitMs > 0) await wait(waitMs);
    attemptConfig = Object.freeze({
      ...config,
      runKind: "rerun",
      supersedesRunId: result.runId,
      convergenceAttempt: attempt + 1
    });
  }

  if (!result) throw new Error("runner_no_result");

  let notification;
  let lastDeliveryError;
  for (const waitMs of retryWaits) {
    if (waitMs) await wait(waitMs);
    try {
      notification = await drain(config, token, result.runId, fetchImpl);
      lastDeliveryError = undefined;
    } catch (error) {
      lastDeliveryError = error;
      dependencies.onNotificationRetry?.(error, waitMs);
      continue;
    }
    if (!notification.current || notification.current.status === "sent" || notification.current.status === "failed") break;
  }
  if (!notification && lastDeliveryError) throw lastDeliveryError;

  return { result, notification, observers };
}
