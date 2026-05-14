const { google } = require("googleapis");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const ROOT_FOLDER_ID = process.env.ROOT_FOLDER_ID || "1IJYqKgdqn4un2QFCo-8lKwtyqRgWLImc";

const ONLYFANS_FOLDER_NAME = "onlyfans tasks";
const MARKETING_FOLDER_NAME = "marketing tasks";

const POLL_INTERVAL_SECONDS = Number(process.env.POLL_INTERVAL_SECONDS || 60);
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 7);
const STATE_FILE = path.join(__dirname, "sent-files.json");

const MODELS = {
  "Felicity Management": {
    displayName: "Felicity",
    onlyfans: process.env.FELICITY_ONLYFANS_WEBHOOK,
    marketing: process.env.FELICITY_MARKETING_WEBHOOK,
  },
  "Fernanda Management": {
    displayName: "Fernanda",
    onlyfans: process.env.FERNANDA_ONLYFANS_WEBHOOK,
    marketing: process.env.FERNANDA_MARKETING_WEBHOOK,
  },
  "Maci Management": {
    displayName: "Maci",
    onlyfans: process.env.MACI_ONLYFANS_WEBHOOK,
    marketing: process.env.MACI_MARKETING_WEBHOOK,
  },
  "Kalia Management": {
    displayName: "Kalia",
    onlyfans: process.env.KALIA_ONLYFANS_WEBHOOK,
    marketing: process.env.KALIA_MARKETING_WEBHOOK,
  },
};

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return {};
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function cleanOldState(state) {
  const maxAge = LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const now = Date.now();

  for (const [fileId, timestamp] of Object.entries(state)) {
    if (!timestamp || now - timestamp > maxAge) {
      delete state[fileId];
    }
  }
}

function getServiceAccountCredentials() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_BASE64) {
    return JSON.parse(
      Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_BASE64, "base64").toString("utf8")
    );
  }

  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  }

  throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_BASE64");
}

async function getDriveClient() {
  const credentials = getServiceAccountCredentials();

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });

  return google.drive({ version: "v3", auth });
}

function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function getMatch(pathParts) {
  const lowerParts = pathParts.map((p) => p.toLowerCase());

  for (const [modelFolderName, modelData] of Object.entries(MODELS)) {
    const modelIndex = lowerParts.indexOf(modelFolderName.toLowerCase());
    if (modelIndex === -1) continue;

    const hasOnlyFans = lowerParts.includes(ONLYFANS_FOLDER_NAME);
    const hasMarketing = lowerParts.includes(MARKETING_FOLDER_NAME);

    if (hasOnlyFans) {
      return {
        modelName: modelData.displayName,
        category: "OnlyFans",
        webhook: modelData.onlyfans,
      };
    }

    if (hasMarketing) {
      return {
        modelName: modelData.displayName,
        category: "Marketing",
        webhook: modelData.marketing,
      };
    }
  }

  return null;
}

function makeDriveLinks(fileId) {
  return {
    preview: `https://drive.google.com/file/d/${fileId}/view`,
    download: `https://drive.google.com/uc?export=download&id=${fileId}`,
  };
}

function isImage(mimeType) {
  return mimeType && mimeType.startsWith("image/");
}

function isVideo(mimeType) {
  return mimeType && mimeType.startsWith("video/");
}

async function sendDiscordNotification(file, match, folderPath) {
  if (!match.webhook) {
    console.log(`Missing webhook for ${match.modelName} ${match.category}`);
    return;
  }

  const links = makeDriveLinks(file.id);
  const relativeFolder = folderPath
    .replace(/^Model Management\s*>\s*/i, "")
    .replace(/^Team A\s*>\s*/i, "")
    .replace(new RegExp(`^${file.modelFolder}\\s*>\\s*`, "i"), "");

  const previewLine =
    isImage(file.mimeType) || isVideo(file.mimeType)
      ? `[Open Preview](${links.preview})`
      : `[Open File](${links.preview})`;

  const embed = {
    title: "📁 New file uploaded",
    description:
      `**Model:** ${match.modelName}\n` +
      `**Category:** ${match.category}\n` +
      `**Folder:** ${relativeFolder || folderPath}\n` +
      `**File:** ${file.name}\n` +
      `**Size:** ${formatBytes(file.size)}\n` +
      `**Download:** [link](${links.download})\n` +
      `**Preview:** ${previewLine}`,
    url: links.preview,
  };

  // Discord can only show real image previews if the link is publicly viewable.
  // Google Drive thumbnails are not always public, so this is best-effort.
  if (isImage(file.mimeType)) {
    embed.image = { url: links.preview };
  }

  const payload = {
    embeds: [embed],
  };

  try {
    const res = await axios.post(match.webhook, payload, {
      headers: { "Content-Type": "application/json" },
      validateStatus: () => true,
    });

    console.log(`Discord response for ${file.name}: ${res.status}`);

    if (res.status === 429) {
      const retryAfter = Number(res.data?.retry_after || 5) * 1000;
      console.log(`Rate limited. Waiting ${retryAfter}ms`);
      await new Promise((r) => setTimeout(r, retryAfter));
      await axios.post(match.webhook, payload);
    }
  } catch (err) {
    console.error(`Discord failed for ${file.name}:`, err.message);
  }
}

async function listChildren(drive, folderId) {
  const files = [];
  let pageToken;

  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields:
        "nextPageToken, files(id, name, mimeType, size, createdTime, modifiedTime, webViewLink)",
      pageToken,
      pageSize: 1000,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    files.push(...res.data.files);
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return files;
}

async function scanFolder(drive, folderId, pathParts, state, cutoffMs) {
  const children = await listChildren(drive, folderId);

  for (const item of children) {
    const currentPath = [...pathParts, item.name];

    if (item.mimeType === "application/vnd.google-apps.folder") {
      await scanFolder(drive, item.id, currentPath, state, cutoffMs);
      continue;
    }

    const createdMs = new Date(item.createdTime).getTime();
    const match = getMatch(pathParts);

    if (match && createdMs >= cutoffMs && !state[item.id]) {
      const modelFolder = pathParts.find((p) => MODELS[p]) || "";
      await sendDiscordNotification(
        { ...item, modelFolder },
        match,
        pathParts.join(" > ")
      );

      state[item.id] = Date.now();
      saveState(state);

      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

async function runOnce() {
  const drive = await getDriveClient();
  const state = loadState();
  cleanOldState(state);

  const cutoffMs = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

  console.log("Scanning Google Drive...");
  await scanFolder(drive, ROOT_FOLDER_ID, ["Model Management"], state, cutoffMs);
  saveState(state);
  console.log("Scan complete.");
}

async function main() {
  console.log("Pampa Drive Notifications started.");
  console.log(`Polling every ${POLL_INTERVAL_SECONDS} seconds.`);

  await runOnce();

  setInterval(async () => {
    try {
      await runOnce();
    } catch (err) {
      console.error("Scan error:", err.message);
    }
  }, POLL_INTERVAL_SECONDS * 1000);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
