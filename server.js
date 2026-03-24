const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const Admin = require("./models/Admin");
const SiteContent = require("./models/SiteContent");
const { DEFAULT_SITE_CONTENT } = require("./defaultContent");
const {
  appendTicketBookingToSheet,
  isGoogleSheetsConfigured,
} = require("./googleSheets");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || "change-me-in-env";
const uploadsDir = path.join(__dirname, "uploads");
const ENV_ADMIN_USERNAME = String(process.env.ADMIN_USERNAME || "").trim().toLowerCase();
const ENV_ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || "");
const ENV_ADMIN_DISPLAY_NAME = String(process.env.ADMIN_DISPLAY_NAME || "Backstage Admin");

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      const allow =
        /^http:\/\/localhost:\d+$/.test(origin) ||
        /^http:\/\/127\.0\.0\.1:\d+$/.test(origin);
      if (allow) return callback(null, true);
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);
app.use(express.json());
app.use("/uploads", express.static(uploadsDir));

app.get("/", (req, res) => {
  res.send("Backend is running");
});

const ensureAuth = (req, res, next) => {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) {
      return res.status(401).json({ message: "Unauthorized." });
    }
    const decoded = jwt.verify(token, JWT_SECRET);
    req.admin = decoded;
    return next();
  } catch {
    return res.status(401).json({ message: "Invalid or expired token." });
  }
};

const isMongoConnected = () => mongoose.connection.readyState === 1;
let mongoConnectPromise = null;

const buildAuthResponse = ({ id, username, displayName, role = "admin" }) => {
  const token = jwt.sign({ sub: String(id), username, role }, JWT_SECRET, { expiresIn: "8h" });
  return {
    token,
    admin: {
      id,
      username,
      displayName,
      role,
    },
  };
};

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsDir),
    filename: (_req, file, cb) => {
      const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
      cb(null, `${Date.now()}-${safeName}`);
    },
  }),
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) return cb(null, true);
    return cb(new Error("Only image uploads are allowed."));
  },
  limits: { fileSize: 10 * 1024 * 1024 },
});

const normalizeTextArray = (value) =>
  Array.isArray(value) ? value.map((v) => String(v || "").trim()).filter(Boolean) : [];

const sanitizeLatestEvent = (value = {}) => ({
  title: String(value?.title || "").trim(),
  poster: String(value?.poster || "").trim(),
  date: String(value?.date || "").trim(),
  time: String(value?.time || "").trim(),
  venue: String(value?.venue || "").trim(),
  description: String(value?.description || "").trim(),
});

const normalizeText = (value, maxLength = 500) => String(value || "").trim().slice(0, maxLength);

const sanitizeTicketBookingPayload = (value = {}) => ({
  name: normalizeText(value?.name, 160),
  email: normalizeText(value?.email, 160).toLowerCase(),
  message: normalizeText(value?.message, 1000),
  pageUrl: normalizeText(value?.pageUrl, 300),
});

const isValidEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());

const sanitizeSiteContentPayload = (payload = {}) => {
  const safe = {
    gallery: {
      images: normalizeTextArray(payload.gallery?.images),
    },
    timeline: Array.isArray(payload.timeline)
      ? payload.timeline
          .map((item) => ({
            year: String(item?.year || "").trim(),
            title: String(item?.title || "").trim(),
            desc: String(item?.desc || "").trim(),
          }))
          .filter((item) => item.year || item.title || item.desc)
      : [],
    navarasas: Array.isArray(payload.navarasas)
      ? payload.navarasas
          .map((item) => ({
            id: String(item?.id || "").trim(),
            name: String(item?.name || "").trim(),
            subtitle: String(item?.subtitle || "").trim(),
            plays: normalizeTextArray(item?.plays),
          }))
          .filter((item) => item.id)
      : [],
    castBatches: Array.isArray(payload.castBatches)
      ? payload.castBatches
          .map((item) => ({
            id: String(item?.id || "").trim(),
            label: String(item?.label || "").trim(),
            yearRange: String(item?.yearRange || "").trim(),
            members: normalizeTextArray(item?.members),
            photos: normalizeTextArray(item?.photos),
          }))
          .filter((item) => item.id && item.label && item.yearRange)
      : [],
    governors: Array.isArray(payload.governors)
      ? payload.governors
          .map((item) => ({
            name: String(item?.name || "").trim(),
            role: String(item?.role || "").trim(),
            quote: String(item?.quote || "").trim(),
            funFact: String(item?.funFact || "").trim(),
            department: String(item?.department || "").trim(),
            contactInfo: String(item?.contactInfo || "").trim(),
            zodiacSign: String(item?.zodiacSign || "").trim(),
            img: String(item?.img || "").trim(),
          }))
          .filter((item) => item.name)
      : [],
    latestEvent: sanitizeLatestEvent(payload.latestEvent),
  };
  return safe;
};

const buildFallbackSiteContent = () => ({
  key: "main",
  ...sanitizeSiteContentPayload(DEFAULT_SITE_CONTENT),
  updatedBy: "fallback",
  createdAt: new Date(),
  updatedAt: new Date(),
});

let fallbackSiteContent = buildFallbackSiteContent();

const getFallbackSiteContent = () => fallbackSiteContent;

const updateFallbackSiteContent = (safePayload, updatedBy) => {
  fallbackSiteContent = {
    ...fallbackSiteContent,
    ...safePayload,
    updatedBy: String(updatedBy || "admin"),
    updatedAt: new Date(),
  };
  return fallbackSiteContent;
};

const toPublicContentResponse = (content) => ({
  gallery: content?.gallery || { images: [] },
  timeline: content?.timeline || [],
  navarasas: content?.navarasas || [],
  castBatches: content?.castBatches || [],
  governors: content?.governors || [],
  latestEvent: content?.latestEvent || sanitizeLatestEvent(),
  updatedAt: content?.updatedAt || new Date(),
});

const getOrCreateSiteContent = async () => {
  if (!isMongoConnected()) {
    throw new Error("MongoDB is not connected.");
  }
  let content = await SiteContent.findOne({ key: "main" });
  if (!content) {
    const seeded = sanitizeSiteContentPayload(DEFAULT_SITE_CONTENT);
    content = await SiteContent.create({
      key: "main",
      ...seeded,
      updatedBy: "bootstrap",
    });
  }
  return content;
};

app.post("/api/admin/login", async (req, res) => {
  try {
    const username = String(req.body.username || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    if (!username || !password) {
      return res.status(400).json({ message: "Username and password are required." });
    }

    if (isMongoConnected()) {
      try {
        const admin = await Admin.findOne({ username });
        if (admin) {
          const validPassword = await bcrypt.compare(password, admin.passwordHash);
          if (validPassword) {
            return res.json(
              buildAuthResponse({
                id: admin._id.toString(),
                username: admin.username,
                displayName: admin.displayName,
                role: admin.role,
              })
            );
          }
        }
      } catch (error) {
        console.error("DB login lookup failed, falling back to env credentials:", error.message);
      }
    }

    if (ENV_ADMIN_USERNAME && ENV_ADMIN_PASSWORD) {
      const validEnvCredentials = username === ENV_ADMIN_USERNAME && password === ENV_ADMIN_PASSWORD;
      if (validEnvCredentials) {
        return res.json(
          buildAuthResponse({
            id: "env-admin",
            username: ENV_ADMIN_USERNAME,
            displayName: ENV_ADMIN_DISPLAY_NAME,
            role: "admin",
          })
        );
      }
    }

    return res.status(401).json({ message: "Invalid credentials." });
  } catch (error) {
    console.error("Login failed:", error);
    return res.status(500).json({ message: "Login failed.", error: error.message });
  }
});

app.post("/api/tickets/book", async (req, res) => {
  try {
    const booking = sanitizeTicketBookingPayload(req.body || {});

    if (!booking.name || !booking.email) {
      return res.status(400).json({ message: "Name and email are required." });
    }

    if (!isValidEmail(booking.email)) {
      return res.status(400).json({ message: "Enter a valid email address." });
    }

    if (!isGoogleSheetsConfigured()) {
      return res.status(503).json({
        message: "Ticket booking is temporarily unavailable. Google Sheets setup is still pending on the backend.",
      });
    }

    const result = await appendTicketBookingToSheet({
      ...booking,
      submittedAt: new Date().toISOString(),
      source: booking.pageUrl || String(req.get("referer") || ""),
      referrer: String(req.get("referer") || ""),
      userAgent: normalizeText(req.get("user-agent"), 400),
      ipAddress: normalizeText(req.ip || req.socket?.remoteAddress, 120),
    });

    return res.status(201).json({
      message: "Your booking request has been received.",
      booking: {
        name: booking.name,
        email: booking.email,
      },
      sheet: {
        id: result.spreadsheetId,
        tab: result.sheetTitle,
        range: result.updatedRange,
      },
    });
  } catch (error) {
    const requestId = crypto.randomUUID();
    console.error(`Ticket booking failed [${requestId}]:`, error.message);
    return res.status(500).json({
      message: "Could not submit your booking right now. Please try again shortly.",
      requestId,
    });
  }
});

app.get("/api/content/public", async (_req, res) => {
  try {
    if (!isMongoConnected()) {
      return res.json(toPublicContentResponse(getFallbackSiteContent()));
    }
    const content = await getOrCreateSiteContent();
    return res.json(toPublicContentResponse(content));
  } catch (error) {
    console.error("Public content fetch failed, serving fallback content:", error.message);
    return res.json(toPublicContentResponse(getFallbackSiteContent()));
  }
});

app.get("/api/content/admin", ensureAuth, async (_req, res) => {
  try {
    if (!isMongoConnected()) {
      return res.json(getFallbackSiteContent());
    }
    const content = await getOrCreateSiteContent();
    return res.json(content);
  } catch (error) {
    console.error("Admin content fetch failed, serving fallback content:", error.message);
    return res.json(getFallbackSiteContent());
  }
});

app.put("/api/content/admin", ensureAuth, async (req, res) => {
  try {
    const safePayload = sanitizeSiteContentPayload(req.body || {});
    if (!isMongoConnected()) {
      const content = updateFallbackSiteContent(safePayload, req.admin?.username);
      return res.json({
        message: "Content updated successfully (fallback mode).",
        content,
      });
    }
    const content = await getOrCreateSiteContent();
    content.gallery = safePayload.gallery;
    content.timeline = safePayload.timeline;
    content.navarasas = safePayload.navarasas;
    content.castBatches = safePayload.castBatches;
    content.governors = safePayload.governors;
    content.latestEvent = safePayload.latestEvent;
    content.updatedBy = String(req.admin?.username || "admin");
    await content.save();
    return res.json({ message: "Content updated successfully.", content });
  } catch (error) {
    console.error("Admin content update failed:", error.message);
    return res.status(500).json({ message: "Failed to update content.", error: error.message });
  }
});

app.post("/api/content/admin/upload", ensureAuth, upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "No file uploaded." });
  }
  const fileUrl = `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`;
  return res.json({
    message: "Upload successful.",
    fileUrl,
    fileName: req.file.filename,
  });
});

const ensureBootstrapAdmin = async () => {
  if (!isMongoConnected()) return;
  if (!ENV_ADMIN_USERNAME || !ENV_ADMIN_PASSWORD) return;

  const passwordHash = await bcrypt.hash(ENV_ADMIN_PASSWORD, 12);
  const existing = await Admin.findOne({ username: ENV_ADMIN_USERNAME });

  if (!existing) {
    await Admin.create({
      username: ENV_ADMIN_USERNAME,
      passwordHash,
      displayName: ENV_ADMIN_DISPLAY_NAME,
      role: "admin",
    });
    console.log(`Bootstrap admin created for username: ${ENV_ADMIN_USERNAME}`);
    return;
  }

  existing.passwordHash = passwordHash;
  existing.displayName = ENV_ADMIN_DISPLAY_NAME || existing.displayName;
  if (!existing.role) existing.role = "admin";
  await existing.save();
  console.log(`Bootstrap admin synced for username: ${ENV_ADMIN_USERNAME}`);
};

const connectToMongo = async () => {
  if (isMongoConnected()) return true;
  if (mongoConnectPromise) return mongoConnectPromise;

  const mongoUri = String(process.env.MONGO_URI || "").trim();
  if (!mongoUri) {
    console.warn("MONGO_URI is missing. Backend is running in fallback mode.");
    return false;
  }

  mongoConnectPromise = mongoose
    .connect(mongoUri)
    .then(async () => {
      console.log("MongoDB Connected");
      await ensureBootstrapAdmin();
      await getOrCreateSiteContent();
      return true;
    })
    .catch((err) => {
      console.log("MongoDB Connection Error:", err.message || err);
      return false;
    })
    .finally(() => {
      mongoConnectPromise = null;
    });

  return mongoConnectPromise;
};

mongoose.connection.on("disconnected", () => {
  console.warn("MongoDB disconnected. Using fallback mode until reconnection.");
});

mongoose.connection.on("error", (err) => {
  console.warn("MongoDB connection event error:", err.message || err);
});

connectToMongo();
const reconnectTimer = setInterval(() => {
  if (!isMongoConnected()) {
    connectToMongo();
  }
}, 30000);
if (typeof reconnectTimer.unref === "function") {
  reconnectTimer.unref();
}

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ message: err.message });
  }
  if (err) {
    return res.status(400).json({ message: err.message || "Request failed." });
  }
  return res.status(500).json({ message: "Unexpected server error." });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
