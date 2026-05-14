const { google } = require("googleapis");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const ROOT_FOLDER_ID = process.env.ROOT_FOLDER_ID || "1IJYqKgdqn4un2QFCo-8lKwtyqRgWLImc";
const POLL_INTERVAL_SECONDS = Number(process.env.POLL_INTERVAL_SECONDS || 60);
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 7);

const STATE_FILE = path.join(__dirname, "sent-files.json");

const MODELS = {
  "Felicity Management": {
    name: "Felicity",
    onlyfans: process.env.FELICITY_ONLYFANS_WEBHOOK,
    marketing: process.env.FELICITY_MARKETING_WEBHOOK,
  },
  "Fernanda Management": {
    name: "Fernanda",
    onlyfans: process.env.FERNANDA_ONLYFANS_WEBHOOK,
    marketing: process.env.FERNANDA_MARKETING_WEBHOOK,
  },
  "Maci Management": {
    name: "Maci",
    onlyfans: process.env.MACI_ONLYFANS_WEBHOOK,
    marketing: process.env.MACI_MARKETING_WEBHOOK,
  },
  "Kalia Management": {
    name: "Kalia",
    onlyfans: process.env.KALIA_ONLYFANS_WEBHOOK,
    marketing: process.env.KALIA_MARKETING_WEBHOOK,
  },
};

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return {};
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function getCredentials() {
  return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
}

async function getDrive() {
  const auth = new google.auth.GoogleAuth({
    credentials: getCredentials(),
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });

  return google.drive({ version: "v3", auth });
}

function formatSize(bytes) {
  const n = Number(bytes || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function getMatch(pathParts) {
  const lower = pathParts.map((x) => x.toLowerCase());

  for (const [folderName, model] of Object.entries(MODELS)) {
    if (!lower.includes(folderName.toLowerCase())) continue;

    if (lower.includes("onlyfans tasks")) {
      return { model: model.name, category: "OnlyFans", webhook: model.onlyfans };
    }

    if (lower.includes("marketing tasks")) {
      return { model: model.name, category: "Marketing", webhook: model.marketing };
    }
  }

  return null;
}

async function listChildren(drive, folderId) {
  let all = [];
  let pageToken;

  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken, files(id,name,mimeType,size,createdTime)",
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    all = all.concat(res.data.files || []);
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return all;
}

async function scanFolder(drive, folderId, pathParts, state, cutoffMs) {
  const items = await listChildren(drive, folderId);

  for (const item of items) {
    const newPath = [...pathParts, item.name];

    if (item.mimeType === "application/vnd.google-apps.folder") {
      await scanFolder(drive, item.id, newPath, state, cutoffMs);
      continue;
    }

    const createdMs = new Date(item.createdTime).getTime();
    if (createdMs < cutoffMs) continue;
    if (state[item.id]) continue;

    const match = getMatch(pathParts);
    if (!match || !match.webhook) continue;

    await sendDiscord(item, match, pathParts.join(" > "));

    state[item.id] = Date.now();
    saveState(state);

    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function sendDiscord(file, match, folderPath) {
  const previewLink = `https://drive.google.com/file/d/${file.id}/view`;
  const downloadLink = `https://drive.google.com/uc?export=download&id=${file.id}`;

  const cleanFolder = folderPath
    .replace("Model Management > Team A > ", "")
    .replace(`${match.model} Management > `, "");

  const message = {
    embeds: [
      {
        title: "📁 New file uploaded",
        description:
          `**Model:** ${match.model}\n` +
          `**Category:** ${match.category}\n` +
          `**Folder:** ${cleanFolder}\n` +
          `**File:** ${file.name}\n` +
          `**Size:** ${formatSize(file.size)}\n` +
          `**Download:** [link](${downloadLink})\n` +
          `**Preview:** [open preview](${previewLink})`,
        url: previewLink,
      },
    ],
  };

  const res = await axios.post(match.webhook, message, {
    validateStatus: () => true,
  });

  console.log(`Discord response for ${file.name}: ${res.status}`);
}

async function runOnce() {
  const drive = await getDrive();
  const state = loadState();

  const cutoffMs = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

  console.log("Scanning...");
  await scanFolder(drive, ROOT_FOLDER_ID, ["Model Management"], state, cutoffMs);
  console.log("Scan complete.");
}

async function main() {
  console.log("Pampa Drive Notifications started.");

  await runOnce();

  setInterval(() => {
    runOnce().catch((err) => console.error("Scan error:", err.message));
  }, POLL_INTERVAL_SECONDS * 1000);
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
