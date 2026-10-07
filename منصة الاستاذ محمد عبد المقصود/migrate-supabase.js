const fs = require('fs');
const path = require('path');

try {
  for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match && !line.trim().startsWith('#') && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
} catch (error) {}

const baseUrl = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const bucket = 'platform-files';
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const databaseFile = process.env.LOCAL_DB_FILE || path.join(dataDir, 'db.json');
const uploadsDir = path.join(dataDir, 'uploads');

async function request(endpoint, options = {}) {
  const response = await fetch(baseUrl + endpoint, {
    ...options,
    headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey, ...options.headers }
  });
  if (!response.ok) throw new Error(`Supabase request failed (${response.status}): ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

async function migrate() {
  if (!baseUrl || !serviceKey) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env or the environment first.');
  if (!fs.existsSync(databaseFile)) throw new Error(`Local database not found: ${databaseFile}`);
  const existing = await request('/rest/v1/platform_state?select=id&id=eq.1');
  if (existing.length) throw new Error('Supabase already contains platform data; migration stopped without overwriting it.');

  const database = JSON.parse(fs.readFileSync(databaseFile, 'utf8'));
  const fileIds = [...new Set([database.settings?.heroFile, ...(database.content || []).map(item => item.fileId)].filter(Boolean))];
  for (const fileId of fileIds) {
    const filePath = path.join(uploadsDir, path.basename(fileId));
    if (!fs.existsSync(filePath)) throw new Error(`Referenced upload is missing: ${path.basename(fileId)}`);
  }

  let uploaded = 0;
  for (const fileId of fileIds) {
    const filePath = path.join(uploadsDir, path.basename(fileId));
    await request('/storage/v1/object/' + bucket + '/' + encodeURIComponent(path.basename(fileId)), {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'x-upsert': 'true' },
      body: fs.readFileSync(filePath)
    });
    uploaded++;
  }

  await request('/rest/v1/platform_state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ id: 1, revision: 0, data: database })
  });
  console.log(`Migration complete. Database imported and ${uploaded} stored files uploaded.`);
}

migrate().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});