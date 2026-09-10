# DROP OS deployment check — customer Action

This repository holds the GitHub Action that DROP OS customers run in their own repository, and
nothing else. It is published so the action reference in a generated workflow can be resolved by
anyone who installs it. The DROP OS product itself stays private.

## What it does

On a real deployment of your staging application, it observes three things from your own
providers and sends DROP OS only scalar facts plus a digest of the browser check:

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

## Support and scope

This action is for staging environments. It refuses live Stripe keys, service-role Supabase keys
and production DROP OS hosts, before any network call.
