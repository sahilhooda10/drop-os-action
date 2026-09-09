# DROP OS customer Action

This directory is the inspectable customer-controlled runner for Truth V1. `action.yml` at the repository root packages it as a composite GitHub Action. It runs on the customer's GitHub-hosted Ubuntu runner and sends DROP OS only three scalar observations plus a digest of the browser selector check.

## Customer-held secrets

Configure these as GitHub Actions secrets. They are read by `runner/index.mjs`, masked immediately, used only against the customer's providers, and never included in the run envelope:

- `DROP_OS_STRIPE_RESTRICTED_KEY` — Stripe test-mode restricted **read-only** key (`rk_test_`). Full `sk_` keys and every `rk_live_` key are refused before Stripe is called.
- `DROP_OS_SUPABASE_PUBLISHABLE_KEY` — current `sb_publishable_` key. A service key is refused.
- `DROP_OS_TEST_EMAIL` and `DROP_OS_TEST_PASSWORD` — dedicated non-human staging account.

GitHub OIDC authenticates each run to DROP OS with audience `dropos-truth-v1`. There is no permanent DROP OS runner token.
The runner sends GitHub's OIDC request credential only to an HTTPS host under `*.actions.githubusercontent.com`; a redirected or malformed request URL is refused before any network call.

The ingestion endpoint has its own exact staging-host allowlist. It must use HTTPS on the default port, contain no credentials, query or fragment, and expose exactly `/api/truth/runs`. `www.dropos.co`, `dropos.co`, and `drop-os-opal.vercel.app` are hard-denied even if supplied in the allowlist. The boundary is rechecked immediately before submission, and redirects are refused so the OIDC token and envelope cannot move to another host.

## Entitlement RPC

The Action signs the dedicated account into the customer's Supabase Auth, then calls one no-argument RPC as that user. The response is closed: exactly `{ "plan_active": boolean }`; additional columns are refused. The session token remains inside the runner.

The Action requires the exact 20-character staging project ref separately and binds it to the canonical `https://<ref>.supabase.co/` hostname. Supabase custom domains are refused because they cannot prove which project is behind the hostname. The DROP OS production ref `zuvxiosuhqpsczjimwwl` is hard-denied. These checks finish before authentication or RPC fetches begin.

`supabase/dropos_read_entitlement.example.sql` is a **template**, not a universal migration. It assumes `public.profiles(id, plan)` and must be reviewed against the customer's staging schema. It uses `security invoker`, so the signed-in user's RLS still applies; it grants only `authenticated` execution.

## Browser check

The Action starts the Chrome already installed on `ubuntu-latest`, signs in through customer-supplied CSS selectors, navigates to the protected route and checks for an access-only selector. It does not collect HTML or screenshots. Evidence is a SHA-256 digest over a small generated JSON statement (`access_granted` and check kind), never page content.

Customers provide one explicit browser network-host allowlist. It must include the staging application host and the canonical `<staging-ref>.supabase.co` host; any additional asset or API host must be named exactly. Login and protected URLs must be HTTPS, have no credentials or fragments, share one origin, use the default HTTPS port, and match the allowlist. Production DROP OS hosts and the production Supabase ref are hard-denied.

Before the first navigation, Chrome pauses every HTTP request at the CDP request stage. A request continues only when its hostname is on the validated staging network allowlist; every other request is failed locally before dispatch. This covers navigations, form submissions, scripts, images and page API calls, so an inherited production integration cannot be contacted by the browser check. The expected staging origin is also rechecked before every credential DOM operation.

See `examples/workflow.yml`. Customers must pin `uses:` to the immutable commit SHA shown during onboarding. The example deliberately has no branch tag.

## Current proof boundary

Provider calls and GitHub have not yet run in a real Actions job. Unit tests use bounded synthetic responses. The browser module has not yet run against a real staging login. The Action is implemented, but it is not release-proven until the connected-repository workflow succeeds end to end.

The configured Stripe test customer and Supabase/browser account are manually bound during onboarding. V1 cannot independently prove that a customer selected the matching Stripe identity; the first end-to-end setup must include a deliberate mismatch negative control.
