const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { v2: cloudinary } = require("cloudinary");
const Admin = require("./models/Admin");
const SiteContent = require("./models/SiteContent");
const { DEFAULT_SITE_CONTENT } = require("./defaultContent");
const {
  appendTicketBookingToSheet,
  isGoogleSheetsConfigured,
} = require("./googleSheets");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const app = express();
app.set("trust proxy", true);
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || "change-me-in-env";
const fallbackContentFile = path.join(__dirname, "siteContent.fallback.json");
const CANONICAL_BACKEND_ORIGIN = "https://prasthanam-backend.onrender.com";
const LEGACY_BACKEND_ORIGINS = ["http://localhost:5000", "http://prasthanam-backend.onrender.com"];
const ENV_ADMIN_USERNAME = String(process.env.ADMIN_USERNAME || "").trim().toLowerCase();
const ENV_ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || "");
const ENV_ADMIN_DISPLAY_NAME = String(process.env.ADMIN_DISPLAY_NAME || "Backstage Admin");
const CLOUDINARY_CLOUD_NAME = String(process.env.CLOUDINARY_CLOUD_NAME || "").trim();
const CLOUDINARY_API_KEY = String(process.env.CLOUDINARY_API_KEY || "").trim();
const CLOUDINARY_API_SECRET = String(process.env.CLOUDINARY_API_SECRET || "").trim();

cloudinary.config({
  cloud_name: CLOUDINARY_CLOUD_NAME,
  api_key: CLOUDINARY_API_KEY,
  api_secret: CLOUDINARY_API_SECRET,
  secure: true,
});

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      const allow =
  /^http:\/\/localhost:\d+$/.test(origin) ||
  /^http:\/\/127\.0\.0\.1:\d+$/.test(origin) ||
  /^https:\/\/.*\.vercel\.app$/.test(origin) ||
  /^https:\/\/prasthanam.*\.vercel\.app$/.test(origin);
      if (allow) return callback(null, true);
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);
app.use(express.json());

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
const isCloudinaryConfigured = () =>
  Boolean(CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET);

const normalizeDate = (value, fallbackValue = new Date()) => {
  const fallbackDate = fallbackValue instanceof Date ? fallbackValue : new Date(fallbackValue);
  const safeFallback = Number.isNaN(fallbackDate.getTime()) ? new Date() : fallbackDate;
  const parsedDate = value instanceof Date ? value : new Date(value);
  return value && !Number.isNaN(parsedDate.getTime()) ? parsedDate : safeFallback;
};

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
  storage: multer.memoryStorage(),
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) return cb(null, true);
    return cb(new Error("Only image uploads are allowed."));
  },
  limits: { fileSize: 10 * 1024 * 1024 },
});

const uploadImageToCloudinary = (file) =>
  new Promise((resolve, reject) => {
    const baseName = path.parse(String(file?.originalname || "upload")).name;
    const safeName = baseName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "upload";

    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "prasthanam/uploads",
        resource_type: "image",
        public_id: `${Date.now()}-${safeName}`,
      },
      (error, result) => {
        if (error) return reject(error);
        return resolve(result);
      }
    );

    stream.end(file.buffer);
  });

const normalizeTextArray = (value) =>
  Array.isArray(value) ? value.map((v) => String(v || "").trim()).filter(Boolean) : [];

const normalizeImageUrl = (value) => {
  const safeValue = String(value || "").trim();
  if (!safeValue) return "";

  for (const legacyOrigin of LEGACY_BACKEND_ORIGINS) {
    if (safeValue === legacyOrigin) {
      return CANONICAL_BACKEND_ORIGIN;
    }
    if (safeValue.startsWith(`${legacyOrigin}/`)) {
      return `${CANONICAL_BACKEND_ORIGIN}${safeValue.slice(legacyOrigin.length)}`;
    }
  }

  return safeValue;
};

const normalizeImageUrlArray = (value) =>
  Array.isArray(value) ? value.map((item) => normalizeImageUrl(item)) : [];

const sanitizeImageUrlArray = (value) => normalizeImageUrlArray(value).filter(Boolean);

const getSiteContentImageUrlSnapshot = (payload = {}) =>
  JSON.stringify({
    gallery: Array.isArray(payload?.gallery?.images)
      ? payload.gallery.images.map((item) => String(item || "").trim())
      : [],
    castBatches: Array.isArray(payload?.castBatches)
      ? payload.castBatches.map((item) =>
          Array.isArray(item?.photos) ? item.photos.map((photo) => String(photo || "").trim()) : []
        )
      : [],
    governors: Array.isArray(payload?.governors)
      ? payload.governors.map((item) => String(item?.img || "").trim())
      : [],
    latestEvent: String(payload?.latestEvent?.poster || "").trim(),
  });

const normalizeSiteContentImageUrls = (payload = {}) => ({
  ...payload,
  gallery: {
    ...(payload?.gallery || {}),
    images: normalizeImageUrlArray(payload?.gallery?.images),
  },
  castBatches: Array.isArray(payload?.castBatches)
    ? payload.castBatches.map((item = {}) => ({
        ...item,
        photos: normalizeImageUrlArray(item?.photos),
      }))
    : [],
  governors: Array.isArray(payload?.governors)
    ? payload.governors.map((item = {}) => ({
        ...item,
        img: normalizeImageUrl(item?.img),
      }))
    : [],
  latestEvent: {
    ...(payload?.latestEvent || {}),
    poster: normalizeImageUrl(payload?.latestEvent?.poster),
  },
});

const sanitizeLatestEvent = (value = {}) => ({
  title: String(value?.title || "").trim(),
  poster: normalizeImageUrl(value?.poster),
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
  const normalizedPayload = normalizeSiteContentImageUrls(payload);
  const safe = {
    gallery: {
      images: sanitizeImageUrlArray(normalizedPayload.gallery?.images),
    },
    timeline: Array.isArray(normalizedPayload.timeline)
      ? normalizedPayload.timeline
          .map((item) => ({
            year: String(item?.year || "").trim(),
            title: String(item?.title || "").trim(),
            desc: String(item?.desc || "").trim(),
          }))
          .filter((item) => item.year || item.title || item.desc)
      : [],
    navarasas: Array.isArray(normalizedPayload.navarasas)
      ? normalizedPayload.navarasas
          .map((item) => ({
            id: String(item?.id || "").trim(),
            name: String(item?.name || "").trim(),
            subtitle: String(item?.subtitle || "").trim(),
            plays: normalizeTextArray(item?.plays),
          }))
          .filter((item) => item.id)
      : [],
    castBatches: Array.isArray(normalizedPayload.castBatches)
      ? normalizedPayload.castBatches
          .map((item) => ({
            id: String(item?.id || "").trim(),
            label: String(item?.label || "").trim(),
            yearRange: String(item?.yearRange || "").trim(),
            members: normalizeTextArray(item?.members),
            photos: sanitizeImageUrlArray(item?.photos),
          }))
          .filter((item) => item.id && item.label && item.yearRange)
      : [],
    governors: Array.isArray(normalizedPayload.governors)
      ? normalizedPayload.governors
          .map((item) => ({
            name: String(item?.name || "").trim(),
            year: String(item?.year || "").trim(),
            role: String(item?.role || "").trim(),
            quote: String(item?.quote || "").trim(),
            funFact: String(item?.funFact || "").trim(),
            department: String(item?.department || "").trim(),
            contactInfo: String(item?.contactInfo || "").trim(),
            zodiacSign: String(item?.zodiacSign || "").trim(),
            img: normalizeImageUrl(item?.img),
          }))
          .filter((item) => item.name)
      : [],
    latestEvent: sanitizeLatestEvent(normalizedPayload.latestEvent),
  };
  return safe;
};

const buildStoredSiteContent = (payload = {}) => ({
  key: "main",
  ...sanitizeSiteContentPayload(payload),
  updatedBy: String(payload?.updatedBy || "fallback").trim() || "fallback",
  createdAt: normalizeDate(payload?.createdAt),
  updatedAt: normalizeDate(payload?.updatedAt),
});

const persistFallbackSiteContent = (content) => {
  try {
    const serializableContent = {
      key: "main",
      ...sanitizeSiteContentPayload(content),
      updatedBy: String(content?.updatedBy || "fallback").trim() || "fallback",
      createdAt: normalizeDate(content?.createdAt).toISOString(),
      updatedAt: normalizeDate(content?.updatedAt).toISOString(),
    };

    fs.writeFileSync(fallbackContentFile, JSON.stringify(serializableContent, null, 2), "utf8");
    return true;
  } catch (error) {
    console.warn("Failed to persist fallback site content:", error.message);
    return false;
  }
};

const buildFallbackSiteContent = () =>
  buildStoredSiteContent({
    ...DEFAULT_SITE_CONTENT,
    updatedBy: "fallback",
    createdAt: new Date(),
    updatedAt: new Date(),
  });

const loadFallbackSiteContent = () => {
  if (!fs.existsSync(fallbackContentFile)) {
    return buildFallbackSiteContent();
  }

  try {
    const rawContent = JSON.parse(fs.readFileSync(fallbackContentFile, "utf8"));
    const content = buildStoredSiteContent(rawContent);
    const normalizedRawContent = normalizeSiteContentImageUrls(rawContent);

    if (getSiteContentImageUrlSnapshot(rawContent) !== getSiteContentImageUrlSnapshot(normalizedRawContent)) {
      persistFallbackSiteContent(content);
    }

    return content;
  } catch (error) {
    console.warn("Failed to load fallback site content, using defaults:", error.message);
    return buildFallbackSiteContent();
  }
};

let fallbackSiteContent = loadFallbackSiteContent();

const getFallbackSiteContent = () => fallbackSiteContent;

const syncFallbackSiteContent = (content) => {
  fallbackSiteContent = buildStoredSiteContent(content);
  persistFallbackSiteContent(fallbackSiteContent);
  return fallbackSiteContent;
};

const updateFallbackSiteContent = (safePayload, updatedBy, { hasLatestEvent = true } = {}) => {
  const nextContent = {
    ...fallbackSiteContent,
    ...safePayload,
    updatedBy: String(updatedBy || "admin"),
    updatedAt: new Date(),
  };

  if (!hasLatestEvent) {
    nextContent.latestEvent = fallbackSiteContent.latestEvent;
  }

  fallbackSiteContent = buildStoredSiteContent(nextContent);
  persistFallbackSiteContent(fallbackSiteContent);
  return fallbackSiteContent;
};

const toPublicContentResponse = (data) => {
  const normalizedContent = normalizeSiteContentImageUrls(data);
  delete normalizedContent.latestEvent;
  const latestEvent = data?.latestEvent || sanitizeLatestEvent();

  return {
    gallery: normalizedContent?.gallery || { images: [] },
    timeline: data?.timeline || [],
    navarasas: data?.navarasas || [],
    castBatches: normalizedContent?.castBatches || [],
    governors: normalizedContent?.governors || [],
    latestEvent,
    updatedAt: data?.updatedAt || new Date(),
  };
};

const syncStoredSiteContentImageUrls = async (content) => {
  if (!content) return content;

  const plainContent = typeof content.toObject === "function" ? content.toObject() : content;
  const normalizedContent = normalizeSiteContentImageUrls(plainContent);
  const latestEventFromData = plainContent?.latestEvent
    ? {
        ...plainContent.latestEvent,
        poster: normalizeImageUrl(plainContent.latestEvent?.poster),
      }
    : plainContent?.latestEvent;

  if (getSiteContentImageUrlSnapshot(plainContent) === getSiteContentImageUrlSnapshot(normalizedContent)) {
    return content;
  }

  content.gallery = normalizedContent.gallery;
  content.castBatches = normalizedContent.castBatches;
  content.governors = normalizedContent.governors;
  content.latestEvent = latestEventFromData;

  if (typeof content.save === "function") {
    await content.save();
  }

  return content;
};

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
  return syncStoredSiteContentImageUrls(content);
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
    const data = typeof content.toObject === "function" ? content.toObject() : content;
    console.log("DB latestEvent:", data.latestEvent);
    return res.json(toPublicContentResponse(data));
  } catch (error) {
    console.error("Public content fetch failed, serving fallback content:", error.message);
    return res.json(toPublicContentResponse(getFallbackSiteContent()));
  }
});

app.get("/api/content/admin", ensureAuth, async (_req, res) => {
  try {
    if (!isMongoConnected()) {
      return res.json(normalizeSiteContentImageUrls(getFallbackSiteContent()));
    }
    const content = await getOrCreateSiteContent();
    return res.json(normalizeSiteContentImageUrls(typeof content.toObject === "function" ? content.toObject() : content));
  } catch (error) {
    console.error("Admin content fetch failed, serving fallback content:", error.message);
    return res.json(normalizeSiteContentImageUrls(getFallbackSiteContent()));
  }
});

app.put("/api/content/admin", ensureAuth, async (req, res) => {
  try {
    const hasLatestEvent = Object.prototype.hasOwnProperty.call(req.body || {}, "latestEvent");
    const safePayload = sanitizeSiteContentPayload(req.body || {});
    if (!isMongoConnected()) {
      const content = updateFallbackSiteContent(safePayload, req.admin?.username, { hasLatestEvent });
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
    if (hasLatestEvent) {
      content.latestEvent = safePayload.latestEvent;
    }
    content.updatedBy = String(req.admin?.username || "admin");
    await content.save();
    syncFallbackSiteContent(content);
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

  if (!isCloudinaryConfigured()) {
    return res.status(500).json({ message: "Cloudinary is not configured." });
  }

  const uploadedImage = await uploadImageToCloudinary(req.file);
  const fileUrl = String(uploadedImage.secure_url || uploadedImage.url || "").trim();

  return res.json({
    message: "Upload successful.",
    fileUrl,
    fileName: uploadedImage.public_id,
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
      const content = await getOrCreateSiteContent();
      syncFallbackSiteContent(content);
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

// fix uploads static serving

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
