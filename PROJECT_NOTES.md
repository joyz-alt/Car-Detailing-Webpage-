# Épure Auto — Project Notes

This file is the running checklist for improvements and issues noticed while developing/testing the site. Keep it updated as items are fixed. It is safe to commit; **do not put passwords, API keys, tokens, database URLs, or other secrets here**.

Last reviewed: 25 October 2026

## Urgent reminder — Monday 26 October 2026, 15:00
- [ ] **Priority: restore the INSEE Sirene diffusion status to non-public.** The status-change request was accidentally submitted toward public dissemination. After the change takes effect (the portal says up to 24 hours), revisit the official [INSEE Sirene diffusion-status service](https://statut-diffusion-sirene.insee.fr/), check the current status, select the option to be excluded from public dissemination, and carefully verify the summary before confirming. Goal: **“Ne fait pas partie de la diffusion publique.”** Do not confirm unless the summary clearly shows the intended change.

## Current status

The booking and legal groundwork has been implemented in the code on `main`, but the website is **not yet ready for public bookings**. Legal details and production integrations still need to be completed and tested.

### Done in the code

- [x] Simplified the booking flow to three steps: choose one of two services, choose a date/time, then enter contact details and the intervention address.
- [x] Removed the requirement for customers to select a vehicle or answer water/electricity questions in the booking form.
- [x] Added two service options and aligned the code prices: Essentiel — **75 €**; Intégral — **150 €**. These are proposed launch prices; verify them against real costs before launch.
- [x] Added address validation for a service area of up to 25 km straight-line distance from Marché Victor Hugo, Angoulême.
- [x] Added draft legal pages: mentions légales, privacy policy, CGV, and a withdrawal form.
- [x] Added acceptance of the CGV and acknowledgement of the privacy policy to the booking form.
- [x] Added an on-page message reminding customers to check their spam/junk folder if they do not receive the email.
- [x] Added an email outbox/retry mechanism and integration tests for booking storage and queued notifications.
- [x] Added Stripe Checkout support when Stripe and its webhook are configured; payment confirmation relies on the verified webhook.
- [x] Added a manual-review fallback if online payment is not configured.
- [x] Added automated syntax/integration checks in GitHub Actions; the earlier booking/integration change passed its checks.

### Still to do

#### Priority 1 — legal and launch readiness
- [ ] Complete all placeholders in the legal pages with the correct business status/name, professional address, SIREN/SIRET, contact details, cancellation/refund policy, complaint contact, and consumer mediator details as applicable.
- [ ] Review the legal pages against the actual booking, payment, cancellation and privacy practices before accepting customers.
- [ ] Confirm the correct consent wording and behavior for services booked within the 14-day withdrawal period. A shorter wording update is proposed in PR #5 and still needs to be merged and checked.
- [ ] Configure production email sending and verify delivery to Gmail, Outlook and other providers. The spam-folder message helps users but does not itself solve deliverability.
- [ ] Configure and test Stripe secrets, webhook, return URLs and a full test payment before enabling paid bookings.
- [ ] Confirm database schema/migrations and environment variables are correctly configured in production.

#### Priority 2 — booking form and front end
- [ ] Add optional photo upload to the customer booking form (the server supports photos, but the current simplified form does not show an upload field).
- [ ] Split the intervention address into clear fields where practical: street number and name, postcode, and town/city; ensure server-side validation still works and combines these fields correctly.
- [ ] Make the CGV acceptance and privacy acknowledgement appear clearly on separate lines, as requested.
- [ ] Review typography and spacing so text is consistently readable and no headings/body text appear too large or too small.
- [ ] Remove any unprofessional water/electricity emojis or references if they remain in any part of the site; those questions have already been removed from the main booking form.
- [ ] Update the “Comment ça marche” steps: the current page still says the customer should provide vehicle details, although this is no longer required in the booking form.
- [ ] Replace the temporary results/photo placeholders with real, permission-cleared before/after photos when available.
- [ ] Check mobile layout, keyboard navigation, labels, validation messages and contrast.

#### Priority 3 — business and customer experience
- [ ] Check the 75 € / 150 € pricing against actual product costs, travel, time, insurance, charges and desired margin before launch.
- [ ] Test the full customer journey: availability → booking → email notifications → payment (if configured) → webhook confirmation → admin view → cancellation/expiry behavior.
- [ ] Verify that the 25 km address check handles geocoding errors and addresses near the service-area boundary gracefully.
- [ ] Confirm email templates and admin notifications are clear, professional and contain the right booking details.
- [ ] Review deployment documentation and make sure no secrets are committed to Git.

## Notes about configuration

- Use the deployment platform's environment-variable settings for production secrets.
- Keep the real local `.env` file private and untracked. Never use it as a notes file.
- Put progress, ideas and issues in this `PROJECT_NOTES.md` file instead.
- The example environment file (`.env.example`) should contain only placeholder values and configuration names, never real credentials.

## Recent GitHub work

- Main booking/legal implementation is present on `main`.
- PR #5: [Simplify early-start withdrawal consent](https://github.com/joyz-alt/Car-Detailing-Webpage-/pull/5) — wording-only change; check CI and merge when ready.
