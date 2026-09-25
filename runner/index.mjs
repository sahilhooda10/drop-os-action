#!/usr/bin/env node
import { readRunnerConfig } from "./config.mjs";
import { describeRunnerFailure, requestOidcToken } from "./run.mjs";
import { executePaidAccessCheck } from "./orchestrate.mjs";

function mask(value) {
  if (value) process.stdout.write(`::add-mask::${String(value).replace(/[\r\n]/g, "")}\n`);
}

async function main() {
  const config = readRunnerConfig();
  for (const secret of [config.stripeKey, config.supabaseKey, config.testEmail, config.testPassword, process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN]) mask(secret);
  const token = await requestOidcToken();
  mask(token);
  const { result, notification } = await executePaidAccessCheck(config, token, {
    onObservers(observers) {
      for (const observer of observers) {
        const reason = observer.outcome === "observed" ? "" : `:${observer.unavailableReason}`;
        process.stdout.write(`DROP OS observer ${observer.subsystem}: ${observer.outcome}${reason}\n`);
      }
    },
    onResult(outcome, attempt) {
      process.stdout.write(`DROP OS check ${attempt + 1}: ${outcome.verdict} (${outcome.lifecycleStatus})\n`);
    },
    onConvergenceWait(waitMs) {
      process.stdout.write(`DROP OS is waiting for the bounded convergence window (${Math.ceil(waitMs / 1000)}s)\n`);
    },
    onNotificationRetry() {
      process.stdout.write("DROP OS alert endpoint was temporarily unavailable; retrying within the delivery bound\n");
    }
  });
  if (notification) {
    process.stdout.write(`DROP OS alerts: sent=${notification.sent} delayed=${notification.delayed} failed=${notification.failed}\n`);
    if (notification.current && notification.current.status !== "sent") {
      process.exitCode = 3;
    }
  }
  process.stdout.write(`DROP OS verdict: ${result.verdict}\n`);
  if (result.verdict !== "PASS" && !process.exitCode) process.exitCode = 2;
}

main().catch(error => {
  const { annotation, line } = describeRunnerFailure(error);
  if (annotation) process.stdout.write(`${annotation}\n`);
  process.stderr.write(`${line}\n`);
  process.exitCode = 1;
});
