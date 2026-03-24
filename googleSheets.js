const crypto = require("crypto");

const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_SHEETS_API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const GOOGLE_SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const DEFAULT_TICKET_SPREADSHEET_ID = "1orVQ0AxpButerxWqD_vwcWtaIBPTQ_EoTWUGM5e85EA";
const ACCESS_TOKEN_BUFFER_MS = 60 * 1000;

let accessTokenCache = {
  token: "",
  expiresAt: 0,
};

let sheetTitleCache = "";

const getSpreadsheetId = () =>
  String(process.env.GOOGLE_SHEETS_SPREADSHEET_ID || DEFAULT_TICKET_SPREADSHEET_ID).trim();

const getServiceAccountEmail = () => String(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "").trim();

const getServiceAccountPrivateKey = () =>
  String(process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "")
    .replace(/\\n/g, "\n")
    .trim();

const isGoogleSheetsConfigured = () =>
  Boolean(getSpreadsheetId() && getServiceAccountEmail() && getServiceAccountPrivateKey());

const base64UrlEncode = (value) =>
  Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

const getGoogleErrorMessage = (payload, fallbackMessage) =>
  String(payload?.error?.message || payload?.error_description || payload?.error || fallbackMessage);

const buildServiceAccountAssertion = () => {
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = {
    alg: "RS256",
    typ: "JWT",
  };
  const claims = {
    iss: getServiceAccountEmail(),
    scope: GOOGLE_SHEETS_SCOPE,
    aud: GOOGLE_OAUTH_TOKEN_URL,
    exp: issuedAt + 3600,
    iat: issuedAt,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedClaims = base64UrlEncode(JSON.stringify(claims));
  const unsignedToken = `${encodedHeader}.${encodedClaims}`;
  const signer = crypto.createSign("RSA-SHA256");

  signer.update(unsignedToken);
  signer.end();

  const signature = signer
    .sign(getServiceAccountPrivateKey(), "base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

  return `${unsignedToken}.${signature}`;
};

const fetchJson = async (url, options = {}, fallbackMessage = "Request failed.") => {
  const response = await fetch(url, options);
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(getGoogleErrorMessage(payload, fallbackMessage));
  }

  return payload;
};

const getGoogleAccessToken = async () => {
  if (!isGoogleSheetsConfigured()) {
    throw new Error(
      "Google Sheets ticket booking is not configured. Set GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY in backend/.env."
    );
  }

  if (accessTokenCache.token && Date.now() < accessTokenCache.expiresAt - ACCESS_TOKEN_BUFFER_MS) {
    return accessTokenCache.token;
  }

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: buildServiceAccountAssertion(),
  });

  const payload = await fetchJson(
    GOOGLE_OAUTH_TOKEN_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    },
    "Failed to authenticate with Google Sheets."
  );

  accessTokenCache = {
    token: String(payload.access_token || ""),
    expiresAt: Date.now() + Number(payload.expires_in || 3600) * 1000,
  };

  if (!accessTokenCache.token) {
    throw new Error("Google Sheets did not return an access token.");
  }

  return accessTokenCache.token;
};

const escapeSheetTitle = (value) => `'${String(value || "").replace(/'/g, "''")}'`;

const buildSheetRange = (sheetTitle, cells) => `${escapeSheetTitle(sheetTitle)}!${cells}`;

const getSheetTitle = async (accessToken) => {
  const configuredTitle = String(process.env.GOOGLE_SHEETS_TAB_NAME || "").trim();
  if (configuredTitle) return configuredTitle;
  if (sheetTitleCache) return sheetTitleCache;

  const spreadsheetId = getSpreadsheetId();
  const payload = await fetchJson(
    `${GOOGLE_SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties.title`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
    "Failed to load Google Sheet metadata."
  );

  const detectedTitle = String(payload?.sheets?.[0]?.properties?.title || "").trim();
  if (!detectedTitle) {
    throw new Error("Could not find a worksheet tab in the target spreadsheet.");
  }

  sheetTitleCache = detectedTitle;
  return detectedTitle;
};

const ensureHeaderRow = async (accessToken, sheetTitle) => {
  const spreadsheetId = getSpreadsheetId();
  const headerRange = buildSheetRange(sheetTitle, "A1:H1");

  const currentHeader = await fetchJson(
    `${GOOGLE_SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(headerRange)}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
    "Failed to read the ticket sheet header."
  );

  const hasHeader = Array.isArray(currentHeader?.values?.[0]) && currentHeader.values[0].some((cell) => String(cell).trim());
  if (hasHeader) return;

  await fetchJson(
    `${GOOGLE_SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(headerRange)}?valueInputOption=RAW`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        values: [
          [
            "Submitted At",
            "Name / Roll Number",
            "Email",
            "Message",
            "Source",
            "Referrer",
            "User Agent",
            "IP Address",
          ],
        ],
      }),
    },
    "Failed to initialize the ticket sheet header."
  );
};

const appendTicketBookingToSheet = async (booking) => {
  const accessToken = await getGoogleAccessToken();
  const sheetTitle = await getSheetTitle(accessToken);
  const spreadsheetId = getSpreadsheetId();

  await ensureHeaderRow(accessToken, sheetTitle);

  const appendRange = buildSheetRange(sheetTitle, "A:H");
  const payload = await fetchJson(
    `${GOOGLE_SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(appendRange)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        values: [
          [
            booking.submittedAt,
            booking.name,
            booking.email,
            booking.message,
            booking.source,
            booking.referrer,
            booking.userAgent,
            booking.ipAddress,
          ],
        ],
      }),
    },
    "Failed to append the ticket booking to Google Sheets."
  );

  return {
    spreadsheetId,
    sheetTitle,
    updatedRange: String(payload?.updates?.updatedRange || ""),
  };
};

module.exports = {
  appendTicketBookingToSheet,
  getTicketSpreadsheetId: getSpreadsheetId,
  isGoogleSheetsConfigured,
};
