import "dotenv/config";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { createClient } from "@supabase/supabase-js";

const required = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SMS_WEBHOOK_SECRET"];
for (const name of required) {
  if (!process.env[name]) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

const app = express();
app.disable("x-powered-by");
app.use(helmet());
app.use(express.json({ limit: "32kb" }));

const allowedOrigins = (process.env.CORS_ORIGINS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    // Non-browser clients/webhooks may not send an Origin header.
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error("Origin not allowed"));
  }
}));

const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: "draft-8",
  legacyHeaders: false
});
app.use("/api", publicLimiter);

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "freesms-backend" });
});

// Public directory endpoint. It returns only active numbers, never provider IDs.
app.get("/api/numbers", async (req, res) => {
  const country = String(req.query.country || "").toUpperCase();
  if (country && !["US", "GB"].includes(country)) {
    return res.status(400).json({ error: "country must be US or GB" });
  }

  let query = supabase
    .from("phone_numbers")
    .select("id, phone_number, country_code, created_at")
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(100);

  if (country) query = query.eq("country_code", country);

  const { data, error } = await query;
  if (error) {
    console.error("Number directory query failed:", error.message);
    return res.status(500).json({ error: "Unable to load numbers" });
  }
  return res.json({ numbers: data || [] });
});

// Public inbox endpoint. Only unexpired messages are returned.
// Public temporary inboxes are visible to everyone; do not use for sensitive messages.
app.get("/api/numbers/:id/messages", async (req, res) => {
  const { id } = req.params;
  const { data: number, error: numberError } = await supabase
    .from("phone_numbers")
    .select("id, status")
    .eq("id", id)
    .maybeSingle();

  if (numberError) {
    console.error("Number lookup failed:", numberError.message);
    return res.status(500).json({ error: "Unable to load inbox" });
  }
  if (!number || number.status !== "active") {
    return res.status(404).json({ error: "Number not found" });
  }

  const { data, error } = await supabase
    .from("sms_messages")
    .select("id, sender, message_body, received_at, expires_at")
    .eq("phone_number_id", id)
    .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
    .order("received_at", { ascending: false })
    .limit(50);

  if (error) {
    console.error("Inbox query failed:", error.message);
    return res.status(500).json({ error: "Unable to load inbox" });
  }
  return res.json({ messages: data || [] });
});

// Provider adapter endpoint: translate your SMS provider's webhook into this
// normalized JSON shape only after verifying the provider's own signature.
// Do not point a provider at this endpoint until its signature verification
// has been implemented for that provider.
app.post("/webhooks/sms", async (req, res) => {
  const supplied = req.get("x-freesms-webhook-secret") || "";
  if (supplied.length !== process.env.SMS_WEBHOOK_SECRET.length ||
      supplied !== process.env.SMS_WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { phone_number, provider_message_id, sender, message_body } = req.body || {};
  if (
    typeof phone_number !== "string" || phone_number.length > 32 ||
    typeof message_body !== "string" || message_body.length < 1 || message_body.length > 5000 ||
    (sender !== undefined && (typeof sender !== "string" || sender.length > 64)) ||
    (provider_message_id !== undefined &&
      (typeof provider_message_id !== "string" || provider_message_id.length > 200))
  ) {
    return res.status(400).json({ error: "Invalid webhook payload" });
  }

  const { data: number, error: lookupError } = await supabase
    .from("phone_numbers")
    .select("id")
    .eq("phone_number", phone_number)
    .eq("status", "active")
    .maybeSingle();

  if (lookupError) {
    console.error("Webhook number lookup failed:", lookupError.message);
    return res.status(500).json({ error: "Unable to process message" });
  }
  if (!number) return res.status(404).json({ error: "Active number not found" });

  const { error: insertError } = await supabase.from("sms_messages").insert({
    phone_number_id: number.id,
    provider_message_id: provider_message_id || null,
    sender: sender || null,
    message_body
  });

  if (insertError) {
    // A repeated provider_message_id is treated as an idempotent delivery.
    if (insertError.code === "23505") return res.status(200).json({ received: true });
    console.error("Webhook insert failed:", insertError.message);
    return res.status(500).json({ error: "Unable to save message" });
  }
  return res.status(200).json({ received: true });
});

app.use((err, _req, res, _next) => {
  if (err?.message === "Origin not allowed") {
    return res.status(403).json({ error: "Origin not allowed" });
  }
  console.error("Unhandled request error:", err);
  return res.status(500).json({ error: "Internal server error" });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`FreeSMS backend listening on port ${port}`));
