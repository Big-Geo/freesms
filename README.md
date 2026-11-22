# FreeSMS backend starter

This is a first backend scaffold for the FreeSMS project. It is designed to run on a Node.js hosting service (not GitHub Pages).

## Important status

- The Supabase database tables are expected to exist: `phone_numbers` and `sms_messages`.
- The backend can list active numbers and read unexpired inbox messages.
- A normalized SMS webhook endpoint is included.
- **No SMS provider is connected yet.** This code does not buy, rent, provision, or activate phone numbers.
- Before connecting a provider, implement that provider's official webhook signature verification. The shared webhook secret in this starter is an additional safeguard, not a substitute for provider signature verification.
- Public temporary inboxes are readable by anyone. Users must be warned not to receive banking, personal, medical, or other sensitive messages.

## Run locally

1. Install Node.js 20 or newer on a computer/server.
2. Copy `.env.example` to `.env`.
3. Fill in the Supabase URL, server-side service-role/secret key, and a long random webhook secret.
4. Run `npm install`, then `npm start`.
5. Visit `/health`.

Never commit `.env` or expose the Supabase service-role/secret key in frontend code.

## API

- `GET /health`
- `GET /api/numbers` (optional `?country=US` or `?country=GB`)
- `GET /api/numbers/:id/messages`
- `POST /webhooks/sms` (requires `x-freesms-webhook-secret` and normalized JSON)

Example normalized webhook body:

```json
{
  "phone_number": "+12025550123",
  "provider_message_id": "provider-message-id",
  "sender": "+12025550000",
  "message_body": "Example message"
}
```

Do not send test or fabricated numbers/messages into the production database.
