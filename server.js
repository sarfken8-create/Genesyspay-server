const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors()); // Accept all frontend origins
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Config ───────────────────────────────────────────────────────────────────
const GENESYSPAY_PUBLIC_KEY  = "pk_iUCrrSFKZkACf0ge9SuMbQI7QXlT3qKw";
const GENESYSPAY_PRIVATE_KEY = "sk_3nNRNAFg81nR61tHAag58eLDWaBEbfX6OraZ2c1isQspx5uwcbuD4WOHEJdvynNe";
const GENESYSPAY_BASE_URL = "https://genesyspay.com/api/v2";
const CALLBACK_URL = process.env.CALLBACK_URL || "https://yourserver.com/webhook";

// ─── Country / Method Map ─────────────────────────────────────────────────────
const COUNTRY_CONFIG = {
  ZM: {
    name: "Zambia",
    currency: "ZMW",
    channel: "mobile_money",
    methods: {
      mtn: "MTN",
      airtel: "Airtel",
      zamtel: "Zamtel",
    },
  },
  CD: {
    name: "Democratic Republic of Congo",
    currency: "CDF",
    channel: "mobile_money",
    methods: {
      mpesa: "M-Pesa",
      airtel: "Airtel",
      orange: "Orange",
      afrimoney: "Afrimoney",
    },
  },
};

// ─── In-memory receipt store ──────────────────────────────────────────────────
// In production, replace with a database
const receipts = {};

// ─── Helper: Build receipt object ────────────────────────────────────────────
function buildReceipt({ tx_ref, status, amount, currency, country, method, phone_number, transaction_id, message, error_code, timestamp }) {
  return {
    receipt: {
      tx_ref,
      transaction_id: transaction_id || null,
      status,       // "success" | "pending" | "failed"
      amount,
      currency,
      country,
      method,
      phone_number,
      message,
      error_code: error_code || null,
      timestamp: timestamp || new Date().toISOString(),
    },
  };
}

// ─── GET /api/countries ───────────────────────────────────────────────────────
// Returns supported countries and their methods so the frontend can build the UI
app.get("/api/countries", (req, res) => {
  const result = Object.entries(COUNTRY_CONFIG).map(([code, cfg]) => ({
    code,
    name: cfg.name,
    currency: cfg.currency,
    methods: Object.entries(cfg.methods).map(([slug, label]) => ({ slug, label })),
  }));
  res.json({ status: "success", data: result });
});

// ─── POST /api/payin ──────────────────────────────────────────────────────────
// Initiates an STK push
app.post("/api/payin", async (req, res) => {
  const { country, method, phone_number, amount } = req.body;

  // ── Validate inputs ──
  const validationErrors = {};

  if (!country) validationErrors.country = "Country is required.";
  if (!method) validationErrors.method = "Payment method is required.";
  if (!phone_number) validationErrors.phone_number = "Phone number is required.";
  if (!amount || isNaN(amount) || Number(amount) <= 0)
    validationErrors.amount = "A valid amount greater than 0 is required.";

  const config = COUNTRY_CONFIG[country];
  if (country && !config) {
    validationErrors.country = `Unsupported country code: ${country}. Supported: ZM, CD.`;
  }
  if (config && method && !config.methods[method]) {
    validationErrors.method = `Unsupported method '${method}' for ${config.name}. Supported: ${Object.keys(config.methods).join(", ")}.`;
  }

  if (Object.keys(validationErrors).length > 0) {
    return res.status(422).json({
      status: "error",
      message: "Validation failed. Please correct the errors below.",
      errors: validationErrors,
    });
  }

  // ── Build transaction reference ──
  const tx_ref = `TXN-${country}-${Date.now()}-${uuidv4().split("-")[0].toUpperCase()}`;

  // ── Call Genesyspay PayIn API ──
  try {
    const payload = {
      amount: Number(amount),
      currency: config.currency,
      country,
      channel: config.channel,
      method,
      phone_number,
      tx_ref,
      callback_url: CALLBACK_URL,
    };

    const response = await axios.post(`${GENESYSPAY_BASE_URL}/payins`, payload, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GENESYSPAY_PRIVATE_KEY}`,
      },
      timeout: 30000,
    });

    const apiData = response.data;

    // Store a pending receipt
    const receipt = buildReceipt({
      tx_ref,
      status: "pending",
      amount,
      currency: config.currency,
      country: config.name,
      method: config.methods[method],
      phone_number,
      transaction_id: apiData?.data?.transaction_id || null,
      message: "STK push sent. Please check your phone and enter your PIN to complete the payment.",
      timestamp: new Date().toISOString(),
    });

    receipts[tx_ref] = receipt.receipt;

    return res.status(200).json({
      status: "success",
      message: "STK push initiated. Check your phone to complete payment.",
      ...receipt,
    });
  } catch (err) {
    // ── Handle Genesyspay API errors ──
    const apiError = err.response?.data;
    const httpStatus = err.response?.status || 500;
    const errorMessage =
      apiError?.message ||
      (err.code === "ECONNABORTED" ? "Request timed out. Please try again." : "An unexpected error occurred. Please try again.");
    const errorCode = apiError?.error_code || err.code || "SERVER_ERROR";

    // ── Specific known error handling ──
    let userFriendlyNote = errorMessage;
    if (errorCode === "MISSING_TOKEN" || errorCode === "INVALID_TOKEN") {
      userFriendlyNote = "Payment service authentication failed. Please contact support.";
    } else if (errorCode === "IP_NOT_ALLOWED") {
      userFriendlyNote = "This server is not authorised to process payments. Please contact support.";
    } else if (httpStatus === 429) {
      userFriendlyNote = "Too many requests. Please wait a moment and try again.";
      errorCode = "RATE_LIMITED";
    } else if (httpStatus === 422) {
      userFriendlyNote = "The payment request was rejected. Please check your details and try again.";
    }

    const receipt = buildReceipt({
      tx_ref,
      status: "failed",
      amount,
      currency: config?.currency || "N/A",
      country: config?.name || country,
      method: config?.methods?.[method] || method,
      phone_number,
      transaction_id: null,
      message: userFriendlyNote,
      error_code: errorCode,
      timestamp: new Date().toISOString(),
    });

    receipts[tx_ref] = receipt.receipt;

    return res.status(httpStatus).json({
      status: "error",
      message: userFriendlyNote,
      error_code: errorCode,
      errors: apiError?.errors || null,
      note: "If this error persists, please contact support with the tx_ref below.",
      ...receipt,
    });
  }
});

// ─── GET /api/receipt/:tx_ref ─────────────────────────────────────────────────
// Fetch a stored receipt by transaction reference
app.get("/api/receipt/:tx_ref", (req, res) => {
  const { tx_ref } = req.params;
  const receipt = receipts[tx_ref];

  if (!receipt) {
    return res.status(404).json({
      status: "error",
      message: `No receipt found for transaction reference: ${tx_ref}`,
      error_code: "RECEIPT_NOT_FOUND",
      note: "The transaction may not have been initiated from this server session.",
    });
  }

  return res.json({ status: "success", receipt });
});

// ─── POST /webhook ────────────────────────────────────────────────────────────
// Receives final transaction status from Genesyspay
app.post("/webhook", (req, res) => {
  const data = req.body;

  console.log("[Webhook] Received:", JSON.stringify(data, null, 2));

  const tx_ref = data?.tx_ref || data?.data?.tx_ref;
  const transaction_id = data?.transaction_id || data?.data?.transaction_id;
  const statusFromApi = data?.status || data?.data?.status;

  if (tx_ref && receipts[tx_ref]) {
    // Update the stored receipt with the final status
    receipts[tx_ref].status = statusFromApi === "success" ? "success" : "failed";
    receipts[tx_ref].transaction_id = transaction_id || receipts[tx_ref].transaction_id;
    receipts[tx_ref].message =
      statusFromApi === "success"
        ? "Payment completed successfully."
        : "Payment failed. Please try again or use a different method.";

    console.log(`[Webhook] Receipt updated for tx_ref=${tx_ref} → status=${receipts[tx_ref].status}`);
  } else {
    console.warn(`[Webhook] No matching receipt for tx_ref=${tx_ref}`);
  }

  // Always respond 200 to acknowledge receipt
  res.status(200).json({ status: "success" });
});

// ─── GET /api/status/:tx_ref ──────────────────────────────────────────────────
// Poll transaction status directly from Genesyspay
app.get("/api/status/:tx_ref", async (req, res) => {
  const { tx_ref } = req.params;

  try {
    const response = await axios.get(`${GENESYSPAY_BASE_URL}/payins?search=${encodeURIComponent(tx_ref)}`, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GENESYSPAY_PRIVATE_KEY}`,
      },
      timeout: 15000,
    });

    const apiData = response.data;

    // Also update local receipt if found
    if (tx_ref && receipts[tx_ref] && apiData?.data) {
      const txData = Array.isArray(apiData.data) ? apiData.data[0] : apiData.data;
      if (txData?.status) {
        receipts[tx_ref].status = txData.status;
        receipts[tx_ref].transaction_id = txData.transaction_id || receipts[tx_ref].transaction_id;
      }
    }

    return res.json({ status: "success", data: apiData?.data || null });
  } catch (err) {
    const apiError = err.response?.data;
    return res.status(err.response?.status || 500).json({
      status: "error",
      message: apiError?.message || "Failed to fetch transaction status.",
      error_code: apiError?.error_code || "STATUS_FETCH_FAILED",
      note: "If this error persists, check your API key and network connection.",
    });
  }
});

// ─── 404 Handler ──────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    status: "error",
    message: `Route ${req.method} ${req.path} not found.`,
    error_code: "ROUTE_NOT_FOUND",
  });
});

// ─── Global Error Handler ─────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error("[Server Error]", err);
  res.status(500).json({
    status: "error",
    message: "An internal server error occurred.",
    error_code: "INTERNAL_ERROR",
    note: "Please try again. If the problem continues, contact support.",
  });
});

// ─── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Genesyspay STK Server running on port ${PORT}`);
  console.log(`Supported countries: Zambia (ZM/ZMW), DR Congo (CD/CDF)`);
  console.log(`Endpoints:`);
  console.log(`  GET  /api/countries          — list countries and methods`);
  console.log(`  POST /api/payin              — initiate STK push`);
  console.log(`  GET  /api/receipt/:tx_ref    — fetch stored receipt`);
  console.log(`  GET  /api/status/:tx_ref     — poll live status from Genesyspay`);
  console.log(`  POST /webhook                — receive Genesyspay webhook callbacks`);
});
