# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The marketing site and commercial-network back office for CHIC · OUF (chicouf.pro), an AI-accompaniment
business. It's a static, no-build site: standalone `.html` pages (each with its own inline `<style>` and
`<script>`, no bundler, no framework, no CDN dependencies) deployed on Vercel, backed by Vercel serverless
functions in `api/` that talk to Airtable (the system of record), Stripe, Anthropic's Claude API, and Make.com
webhooks.

There is no `package.json`, no build step, and no test suite. Editing an `.html` file or a file in `api/` *is*
the deployment artifact — Vercel serves each `api/*.js` file as a function at the matching route.

## Running / testing changes

- No local dev server or build command exists in this repo. Preview changes by opening the `.html` file
  directly, or via `vercel dev` / a Vercel preview deployment if the Vercel CLI is set up locally.
- There is no automated test suite or linter configured — verify changes by reading the code and, where
  possible, exercising the relevant page/endpoint manually.
- Serverless functions require Vercel environment variables to run for real: `AIRTABLE_API_KEY`,
  `SESSION_SECRET`, `ADMIN_SECRET`, `STRIPE_SECRET_KEY_LIVE`, `STRIPE_WEBHOOK_SECRET_TEST` /
  `STRIPE_WEBHOOK_SECRET_LIVE`, `ANTHROPIC_API_KEY`, `MAKE_CONTACT_WEBHOOK_URL`. Without them, functions
  fail closed with a 500 rather than degrading silently.

## Architecture

### Frontend: standalone HTML pages

Each top-level `.html` file is a fully self-contained page — markup, CSS, and JS all inline in the same file.
There's no shared layout, component system, or asset pipeline; shared look-and-feel is achieved by copying
patterns between pages, not by importing anything. When editing UI, expect to find and change the relevant
block directly inside the page's own `<style>`/`<script>`, not in a shared file.

Key pages:
- `index.html` — main marketing site.
- `audit-site.html` — public tool: visitor enters a URL, `POST /api/audit` runs an AI-generated site audit,
  results can be emailed via `POST /api/send-report`.
- `diagnostic-cape.html` — CAPE diagnostic funnel, results are read back via `api/rapport-data.js` and shown
  in `rapport.html` (routed as `/rapport/:id` via `vercel.json`).
- `espace-commercial.html` — the commercial ("CommercI.A.l" network) dashboard: pipeline, client management,
  devis (quotes), commissions, personal Calendly/Zoom links. The largest and most stateful page; talks to
  most of the session-authenticated `api/*` endpoints.
- `admin-commerciaux.html` — admin-only view listing the whole commercial network and setting passwords.
- `connexion.html` / `definir-mot-de-passe.html` — login and password-set/invite-acceptance flows.

### Backend: `api/` serverless functions (Vercel)

Airtable is the single source of truth for consultants, clients, diagnostics, and devis (quotes/audits) —
there is no other database. Every function talks to Airtable's REST API directly with `fetch`, using a
hardcoded `AIRTABLE_BASE_ID` (`appPbx0vHGCSTE9wR`) and per-table IDs (`tblZe72...` = Consultants,
`tblPhDItWoYN7jgtA` = Clients, `tblrZJAmMBa2SKjSF` = Audits/devis, `tblTeIGD63oOOHaob` = Diagnostics,
`tbl2iu6bQ38Un4s8p` = Historique_appels).

**Route-fusion pattern**: Vercel Hobby caps a deployment at 12 functions, so related actions are merged into
one file and dispatched by a query param or body field rather than split into separate routes/files — e.g.
`api/auth.js` handles `?action=login|logout|set-password-with-token`, and `api/request-devis.js` handles
`GET` (detail), plain `POST` (new devis request), and `POST { action: 'update-status'|'set-date-envoi'|
'toggle-commission' }`. When adding a new commercial-facing action, prefer extending an existing route this
way over creating a new file, and check `vercel.json`'s `functions` block if a new route needs a longer
`maxDuration`.

**Session auth** (`api/_session.js`, imported — never itself deployed as a route because of its `_` prefix):
stateless, HMAC-SHA256-signed cookie (`coch_session`), no server-side session store. `verifySession(req)`
reads and validates the cookie and returns `{ sub: consultantRecordId, name, prenom, exp }`. The same
`verifyToken`/`signSession` primitives are reused for password-invite links (`purpose: 'invite'` vs.
`purpose: 'session'` distinguishes them) and passwords are stored as `scrypt` hashes, never in the clear.

**Authorization model**: every endpoint that touches a commercial's data derives the identity *only* from
`verifySession(req)`, never from a client-supplied ID — this is what stops one commercial from reading or
editing another's clients/devis by tampering with the request. Ownership is then double-checked against
Airtable link fields (e.g. `Clients.Consultant_ID` must contain the session's `sub`, `Audits.Consultant`
likewise) before any read or write. `api/admin/*` additionally requires the session's consultant record to
have `Email === 'contact@chicouf.pro'`. Preserve this pattern (session → ownership check → act) in any new
endpoint touching consultant-owned data.

**Devis status machine**: a commercial can only self-serve specific transitions
(`ALLOWED_TRANSITIONS` in `api/request-devis.js`, currently `Envoyé → Signé|Perdu`). Nothing outside Stripe's
webhook is allowed to move a devis to `Payé`, and the amount (`Montant_HT`) is never editable by the
commercial — respect this boundary if extending the status flow.

**Stripe integration** (`api/webhooks/stripe.js`): receives `checkout.session.completed` directly from
Stripe (bypassing Make, which was being blocked by Vercel's firewall on inbound calls) — signature-verified
against `STRIPE_WEBHOOK_SECRET_TEST`/`_LIVE` with `crypto.timingSafeEqual`, body parsing disabled
(`config.api.bodyParser = false`) because the raw body is needed for signature verification. On a completed
checkout it upserts the consultant in Airtable and sends an invite link via a Make webhook (outbound calls
aren't firewalled, only inbound).

**AI usage** (`api/audit.js`, `api/send-report.js`): `api/audit.js` fetches the target site's live HTML,
extracts reliable signals in code (viewport meta, forms, mailto, anti-bot challenge detection, etc.) rather
than trusting the model to infer them, then calls Claude (`claude-haiku-4-5-20251001`) to produce the
qualitative analysis and prioritized recommendations. The audit and report always steer toward the
"Accélérateur IA" offer with no fixed price shown to the prospect — pricing is deliberately discussed only
by phone, never rendered client-side or emailed.

**CA / commission calculations** (`api/admin/commerciaux-list.js`) distinguish two figures per commercial:
`caReseau` (what CHIC · OUF billed *that commercial* via Stripe — kit/subscription) vs. `caClients` (what
that commercial generated from their own clients' paid devis, the base for their 5% commission). Don't
conflate the two when touching this logic.

## Conventions

- All user-facing strings, comments, and Airtable field names are in French; keep new code consistent with
  that.
- Comments in this codebase are used deliberately to explain *why* (a security invariant, a Vercel platform
  constraint, a business rule that isn't obvious from the code) — follow that bar rather than narrating what
  the code does.
- No secrets or table/base IDs beyond what's already hardcoded should be introduced into frontend
  (`.html`) files; anything sensitive stays server-side in `api/` and is read from `process.env`.
