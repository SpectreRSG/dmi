// File uploads (signed contracts, training certificates).
//
// On Netlify, files are kept in Netlify Blobs (private file storage). On your
// computer they go in data/uploads. Either way they get random names, and only
// logged-in users can download them.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const config = require('./config');

// Netlify can receive at most about 4.5 MB in one request, so we stay under that.
const MAX_FILE_MB = 4;
const ALLOWED_EXTENSIONS = [
  '.pdf', '.doc', '.docx', '.odt', '.xls', '.xlsx', '.csv', '.txt', '.png', '.jpg', '.jpeg', '.gif', '.webp',
];

// Reads an uploaded file (form field name "file") into memory. Nothing is
// stored until the form has been checked and saveUpload() is called.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 1, fields: 200 },
}).single('file');

class UploadError extends Error {}

// Where files are kept: Netlify Blobs, or a folder on your computer.
let blobStore = null;
const storage = {
  async save(name, buffer) {
    if (!config.onNetlify) return fs.promises.writeFile(path.join(config.uploadsDir, name), buffer);
    await store().set(name, buffer);
  },
  async read(name) {
    if (!config.onNetlify) {
      const file = path.join(config.uploadsDir, name);
      return fs.existsSync(file) ? fs.promises.readFile(file) : null;
    }
    const data = await store().get(name, { type: 'arrayBuffer' });
    return data ? Buffer.from(data) : null;
  },
  async remove(name) {
    if (!config.onNetlify) return fs.promises.rm(path.join(config.uploadsDir, name), { force: true });
    await store().delete(name);
  },
};

function store() {
  if (!blobStore) blobStore = require('@netlify/blobs').getStore({ name: 'uploads', consistency: 'strong' });
  return blobStore;
}

// Returns { file_name, file_original } or null if no file was chosen.
async function saveUpload(file) {
  if (!file || !file.size) return null;
  const ext = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    throw new UploadError(`That type of file isn't allowed. Allowed types: ${ALLOWED_EXTENSIONS.join(', ')}`);
  }
  const storedName = crypto.randomBytes(16).toString('hex') + ext;
  await storage.save(storedName, file.buffer);
  return { file_name: storedName, file_original: path.basename(file.originalname).slice(0, 200) };
}

async function deleteUpload(storedName) {
  if (storedName) await storage.remove(path.basename(storedName));
}

async function sendUpload(res, storedName, originalName) {
  const data = await storage.read(path.basename(storedName));
  if (!data) {
    return res.status(404).render('error', { title: 'File missing', message: 'That file could not be found.' });
  }
  res.attachment(originalName || storedName);
  res.send(data);
}

module.exports = { upload, saveUpload, deleteUpload, sendUpload, UploadError, MAX_FILE_MB };
