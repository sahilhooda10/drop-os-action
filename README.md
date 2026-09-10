# DROP OS deployment check — customer Action

This repository holds the GitHub Action that DROP OS customers run in their own repository, and
nothing else. It is published so the action reference in a generated workflow can be resolved by
anyone who installs it. The DROP OS product itself stays private.

## What it does

On a real deployment of your application — staging or production, whichever this project
registered — it observes three things from your own providers and sends DROP OS only scalar facts
plus a digest of the browser check:

1. whether the customer's paid period is active in Stripe,
2. whether your application grants that account an entitlement,
3. whether the account can actually reach the protected page.

DROP OS derives the verdict on its server. The action never sends credentials, customer records
or raw evidence. See `runner/README.md` for the full boundary description.

## Requirements

- A GitHub-hosted Ubuntu runner. **No npm dependencies**: the runner uses only Node built-ins.
- **Node 22 or newer.** The browser check opens a Chrome DevTools connection with the global
  `WebSocket`, which Node enables by default from 22. `ubuntu-latest` currently provides Node 24,
  so the generated workflow installs nothing to get it, and the runner checks its own version and
  refuses with `node_22_required` before making any network call. If you pin a different Node in
  your own workflow, keep it at 22 or above.
- Four repository secrets, described in `runner/README.md`.

## Installation

DROP OS generates two workflow files for your project and shows them on your project setup page.
Save both in `.github/workflows/`. The first turns a real deployment into a signed trigger. The
second runs on your authorised branch and is the only one holding an identity token or your
observer secrets.

Pin this action by commit, never by branch or tag:

```yaml
- uses: sahilhooda10/drop-os-action@<40-character commit sha>
```

The workflow DROP OS generates already contains the exact pinned reference. Do not replace it
with a moving reference.

## Entitlement function

`runner/supabase/dropos_read_entitlement.example.sql` is a **template, not a migration**. It
assumes `public.profiles(id, plan)` and must be reviewed against your own schema. It runs as
`security invoker`, so your row-level security still applies, and it grants execution only to
`authenticated`. If your function lives in another schema, pass `supabase-schema`.

## Checking production

Production is opt-in and never inferred. A workflow that says nothing is a staging workflow; DROP
OS writes `target-environment: "production"` into the generated file only for a project registered
that way, and the server refuses a production check against a staging project and the reverse.

Checking production means two live things run on every deployment, and both stay in your GitHub
environment:

- a **live-mode RESTRICTED Stripe key** (`rk_live_`), scoped to reading subscriptions. A full `sk_`
  secret is refused in either environment, and a test key is refused for a production check;
- a **sign-in as a dedicated account you create and control**. Use an account that exists only to
  be checked, never a real customer's, and give it the narrowest entitlement that still proves paid
  access.

Every check also carries a digest of the subject it is configured against — billing customer,
price, entitlement project and RPC, and protected page. DROP OS pins that on the first check and
refuses a different one afterwards, so a check quietly repointed at another customer is rejected
rather than answered.

## What the server verifies, and what you assert

The server verifies the signed GitHub identity of the run, that the deployment happened, that the
contract text is the one sealed for your project, that the environment matches the one you
registered, and that the subject has not changed since the last check. The verdict is derived on
the server from the observations; the runner's own claim is recorded but never used as the result.

You assert that the Stripe customer, the application account and the protected page belong to the
same person. DROP OS cannot verify that, and the three observations agreeing is not evidence of
it — they can agree perfectly about two different people. Prove that binding once yourself during
setup by pointing the check at a deliberately mismatched customer and confirming it does not pass.

## Support and scope

The action refuses full Stripe secret keys, service-role Supabase keys, and the DROP OS production
hosts and project, before any network call.
