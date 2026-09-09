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

## Trainer scheduling safeguards and Trainer Portal

The Trainer Operations assistant is now backed by an authoritative PostgreSQL model instead of Gmail, Calendar, email history, or conversation context. The versioned `trainer-operations-v1.0.0` instruction is stored in `trainer_operation_settings` and is passed to every OpenAI request. The production default is `gpt-5-mini`; set `OPENAI_MODEL` to an approved alternative only after verifying its tool-calling support. Every model tool call is added to the append-only `audit_log` table.

| Typed assistant tool | Server-side control |
|---|---|
| `get_session`, `get_assignment`, `get_approved_materials`, `get_readiness` | Return only data joined to the immutable `session_id`, never inbox or calendar evidence. |
| `create_confirmation_draft`, `submit_send_for_approval` | Create and queue a draft only after readiness is checked. |
| `send_approved_message` | Requires a still-valid human approval, then re-checks the exact assignment, status and current link version before sending. |
| `record_acknowledgement`, `record_access_outcome` | Store explicit replies and attendance/admission incidents against the exact assignment. |

The additive migration at `migrations/20260909_trainer_operations_phase_1_2.sql` creates the Phase 1 `sessions`, `learner_assignments`, `materials`, and `audit_log` records along with the Phase 2 portal, evaluation, invoice, expense, and compliance tables. The established on-demand database provisioner runs the same definitions for existing Railway installations.

`/trainer` is a separate trainer-facing portal: trainers can register with email/password or use Google sign-in, edit only their own contact/payment/photo fields, upload a PDF/DOCX evaluation, attach a receipted expense, and submit evaluation-gated invoices. Other trainers' rates, invoices, profiles, session fees, and margins are not returned by any trainer-facing route. Admin APIs under `/api/trainer-portal/admin/` manage rates, contract status, onboarding, compliance, sessions, approval queues, attention items, and the draft UpskillU invoice. Session fees and margins remain exclusively admin-side.

Set the following secret Railway variables, rather than committing them:

```bash
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5-mini
CRON_SECRET=long-random-value
```

The existing Google Workspace connection must be re-authorized after deployment because evaluation delivery, approval-gated learner messages, and invoice decisions use the Gmail send scope. Add `https://<your-domain>/api/trainer-portal/auth/google/callback` to the Google OAuth client's authorized redirect URIs for trainer Google sign-in.

Evaluation reminders are implemented at `POST /api/trainer-portal/internal/evaluation-reminders` and require `Authorization: Bearer $CRON_SECRET`. The new reminder settings are **disabled by default**, preserving the paused legacy automatic-reminder state. An administrator must explicitly enable the new setting after verification. Two safe deployment options are available:

| Approach | Tradeoffs | Cost | Setup complexity |
|---|---|---:|---|
| Railway scheduled service configured with `0 * * * *` | Uses the existing deployment platform; configure the schedule in Railway service settings and call the protected endpoint. | Included with the existing platform plan where supported. | Low |
| External authenticated HTTP scheduler | Keeps scheduling independent of the application host; secure the `CRON_SECRET` in the scheduler. | Varies by chosen provider. | Low–moderate |

Do not enable either reminder trigger until the migration is applied, Gmail is re-authorized, and the regression suite has passed. This does not re-enable the legacy reminder mechanism.

Provider messages are stored as `provider_evidence` with an explicit `unverified` status. Only an authenticated administrator can promote a candidate provider link through the evidence-verification action; the AI never performs this promotion. The system redacts email addresses, joining links, URLs, message bodies, recipients, and binary files from audit payloads. The AI receives only narrowly scoped, task-necessary data for one immutable session and, where applicable, one learner assignment.

The same protected scheduler endpoint also records the following **disabled-by-default** canonical-session checkpoints in `session_checkpoint_events`: a confirmation record, a business-hours 48–72-hour readiness check, a business-day-before acknowledgement check, the session-start host access-pathway check, and a post-session outcome check. Offsets and business hours live in the `session_checkpoints` administrator setting; they are derived from `starts_at` plus `display_timezone`, never from a hand-entered weekday or standalone date.

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


## Client settings and connected workflows

Signed-in administrators can now use the **Settings** area to set an organisation name, upload a PNG/JPEG/SVG logo (maximum 2MB), manage the Google Workspace connection, and change the deployment’s sole administrator email or password. Branding is stored in `account_settings`; when it has not been configured the application continues to use the **TrueCosmic** name and **TC** mark. The public logo endpoint returns only the stored image bytes and declared image content type.

The first self-service credential change verifies the existing `ADMIN_PASSWORD` and replaces the environment-based login with a bcrypt-hashed `admin_credentials` record. Future sign-ins use that stored hash and the selected administrator email. Administrator settings remain available even when a billing subscription is past due or canceled, so the client can recover access without a billing-state deadlock.

The Operations Agent now reports Google connection status and links to Settings for connect/reconnect actions. Client and guest-speaker cards open persisted profile details and booking history; trainer invitation creates a linked onboarding record; delivery-evidence rows can be uploaded, previewed, and downloaded; global search queries current clients, bookings, and trainers; and message draft checks record the actual five-item checklist state instead of always claiming success.

Run the dedicated settings checks with:

```bash
DATABASE_URL=postgres://... npm run test:settings
```
