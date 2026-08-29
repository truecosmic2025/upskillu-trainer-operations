# UpskillU Trainer Operations

A **Next.js 16 + PostgreSQL** operations portal for training administrators. It retains the original single-tenant trainer-onboarding tracker, Google OAuth integration for Gmail and Calendar, and administrator session login. It now also manages multiple client accounts, booking delivery, people allocation, operational evidence, and human-reviewed weekly communications.

> **Safety principle:** The portal can read connected services and prepare internal drafts, but it never sends external messages or forwards client invites automatically. Staff review and explicitly approve external-facing content or record manual forwarding.

## Core workflows

| Area | What the portal records | Operational control |
|---|---|---|
| **Clients** | Client organisation, primary contact, and contact email | Every booking is tied to a real client record; no client is hard-coded |
| **Bookings** | Session type, 2–3 proposed dates, chosen date, venue, timings, delivery mode, and status | A booking becomes `confirmed` only after the client-chosen date, venue, start time, and finish time are recorded |
| **TBC dates** | Candidate dates stored as JSON records with `tbc`, `chosen`, or `archived` state | Choosing a date explicitly archives the remaining candidate dates and returns/shows those dates rather than silently deleting them |
| **Trainer allocation** | Current trainer directory, monthly potential availability, lead role, booking allocations | Lead trainers are visually listed first and allocations record whether an allocation was a lead pick |
| **Guest speakers** | Speaker directory and per-booking pending/confirmed links | Adding a speaker to a booking creates a separate invite-tracking record; attaching an existing speaker does not duplicate their directory record |
| **Delivery invites** | Manual forwarded/unforwarded state and timestamp per trainer or speaker | The system only records that a human forwarded an invite—no invitation is sent from the portal |
| **Post-session pipeline** | Attendance receipt time, late flag, name checking, client sharing, evaluation forms, certificates | Attendance is marked late when received more than 24 hours after the recorded session end; open items surface in the dashboard Attention cards |
| **Weekly communications** | WhatsApp-ready weekly delivery roundup and Friday trainer reminder | Generated as internal drafts, requiring explicit approval; approval does not send anything and staff copy approved text manually |
| **Entitlements** | Per-account feature flags for bookings, clients, and guest speakers | Every relevant API route checks entitlement state; all flags default to `true` and there is no billing or Stripe integration |

## Data tables

`lib/db.ts` follows the existing `ensureXTables()` pattern and creates the following delivery-operations records when any module is used:

- `clients` and `bookings`;
- `trainers`, `trainer_availability`, and `booking_allocations`;
- `speakers` and `booking_speakers`;
- `delivery_invites`;
- `post_session_pipeline`;
- `digest_drafts`; and
- `account_entitlements`.

The first booking-related request also brings the existing `trainer_onboarding` roster into the new `trainers` table. It will not overwrite any lead-role selection made by an administrator.

## API structure

The project keeps the existing route convention under `app/api/`.

| Route | Supported operations |
|---|---|
| `/api/clients` | List, create, and edit clients |
| `/api/bookings` | List and create bookings; edit invite details; choose/archive held dates; cancel booking |
| `/api/bookings/allocations` | List, allocate, and remove trainers |
| `/api/bookings/invites` | Read and manually record invite-forwarding status |
| `/api/bookings/pipeline` | Read and update post-session evidence fields |
| `/api/trainers` | List/add trainers; record lead role and monthly potential availability |
| `/api/speakers` | List/add speakers; attach an existing speaker to a booking; change confirmation status |
| `/api/digest` | List, create, and approve internal weekly digest/reminder drafts |
| `/api/operations/attention` | Dashboard action cards for overdue delivery records and unforwarded invites |
| `/api/entitlements` | Return active feature flags |

All routes remain protected by the project’s existing session proxy. New booking operations rely on the following existing environment variables:

```bash
DATABASE_URL=postgres://...
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=change-me
SESSION_SECRET=long-random-value
```

The original Google integration additionally uses its existing Google OAuth and encryption settings when connected.

## Claude Operations Agent

The **Operations Agent** uses the official Anthropic Messages API with the current Sonnet model alias, `claude-sonnet-5`. It runs a bounded tool-use loop with a maximum of six research rounds. The model can call only the application-defined tools below; it cannot run arbitrary SQL and it cannot send email or alter calendars.[1] [2]

| Agent tool | Scope | Safety boundary |
|---|---|---|
| `query_pipeline` | Predefined, parameterized operational query shapes for bookings, clients, allocations, speakers, invites, and post-session records | The model selects a query shape, never writes SQL |
| `search_gmail` | Trainer Operations-scoped Gmail metadata search | Read-only, capped at ten results; full bodies are not returned |
| `get_gmail_message` | One Gmail thread already identified by the agent | Read-only metadata and snippets only |
| `search_calendar` | Events inside a validated time range | Read-only; no event creation, editing, or deletion |
| `draft_email` | Gmail **drafts** endpoint | Creates a draft only; there is no Gmail send endpoint anywhere in the agent implementation |

Each executed tool call is stored in `agent_usage_log` with its account/conversation identifier, input, result, timestamp, and response-token usage for future cost reporting. The `operationsAgent` entitlement is enabled by default and is checked before the API route runs.

Configure the Railway deployment with the following new service variable. Leave the value out of source control and provide it in Railway's environment-variable settings:

```bash
ANTHROPIC_API_KEY=
```

If this key is absent, the Operations Agent panel displays a clear setup error instead of crashing. Google OAuth remains required only when the agent needs Gmail, Calendar, or Gmail-draft access. A tool that creates a Gmail draft still requires a person to open, review, and send that draft outside the agent.

## Stripe subscription billing

The portal supports one Kromdigital Stripe customer and **one Stripe subscription per client account**. The base subscription provides the delivery-operations features for **$119.00/month**. The optional AI add-on is a second subscription item for **$39.00/month**, and it is the only normal billing path that enables the Operations Agent.

Only the Stripe secret key and webhook signing secret are required in Railway service variables. They are never stored in source control:

```bash
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
```

On its first billing use, `ensureBillingPrices()` resolves two active recurring monthly Price objects by lookup key. If either is missing, it creates the Product and Price through the Kromdigital Stripe account, using `upskillu_base_monthly_119` at `11900` cents and `upskillu_ai_addon_monthly_39` at `3900` cents. The result is cached for the process lifetime. On a cold start or redeploy, the lookup keys make the same operation idempotent rather than creating duplicates.[6]

The Checkout endpoint accepts `includeAiAddon` and the per-account `trialDays` choice (`0` or `14`). A 14-day trial is added only when requested; immediate billing omits the trial parameter. The endpoint records the Stripe Checkout session but leaves the billing state inactive until a verified webhook updates it.

Register the deployed `https://<your-portal>/api/billing/webhook` URL in the Kromdigital Stripe Dashboard and subscribe it to `checkout.session.completed`, `customer.subscription.updated`, and `customer.subscription.deleted`. Stripe webhook verification uses the original request body, the `Stripe-Signature` header, and `STRIPE_WEBHOOK_SECRET`; payloads that fail verification are rejected without any database change.[3]

> **One-subscription safeguard:** Stripe Checkout creates a new subscription. For an account with an existing base subscription, the AI add-on UI calls the same secure endpoint, which adds the dynamically resolved AI add-on Price as an item on the existing subscription instead. This retains the requested one-subscription, two-item model. Stripe documents subscription items as the supported way to add an item without replacing existing items.[4]

The billing state is available at `/api/billing/status`. Accounts in `past_due` or `canceled` status retain read access but all booking, client, trainer, speaker, allocation, invite, pipeline, and digest mutations receive a 403 response. Active, trialing, and internal-only `comped` accounts can write. The `comped` route requires the configured internal administrator and Stripe webhooks deliberately do not override that status. The customer portal route creates a short-lived Stripe-hosted management link for an authenticated customer.[5]

## Local development

```bash
npm install
npm run dev
```

For a production compilation check:

```bash
npm run build
```

The project requires PostgreSQL for runtime data operations. Tables are provisioned automatically through the existing database helper when the corresponding endpoints are used.

## Verification coverage

The repository includes `tests/booking-operations.test.mjs`, a contract test that verifies the required routes, table definitions, human-approval language, held-date archival support, and attendance-late implementation are included in the working tree. Run it with:

```bash
node --test tests/booking-operations.test.mjs
```

The Operations Agent test suite includes a real PostgreSQL test for its predefined pipeline queries and usage logging, a mocked Claude tool-use round trip to final answer, a draft-only endpoint check, and a missing-key failure check. The Stripe billing suite adds verified webhook, entitlement, lapse-gate, trial, comped-account, subscription lifecycle, and dynamic Price idempotency tests. Provide a test database URL when running the full suite:

```bash
DATABASE_URL=postgres://... npm test
```

## References

[1]: https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview "Anthropic: Tool use with Claude"
[2]: https://platform.claude.com/docs/en/models/overview "Anthropic: Models overview"
[3]: https://docs.stripe.com/webhooks "Stripe: Receive Stripe events in your webhook endpoint"
[4]: https://docs.stripe.com/api/subscription_items/create "Stripe: Create a subscription item"
[5]: https://docs.stripe.com/customer-management/integrate-customer-portal "Stripe: Integrate the customer portal with the API"
[6]: https://docs.stripe.com/api/prices/list "Stripe: List Prices by lookup key"
