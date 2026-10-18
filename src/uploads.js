// File uploads (signed contracts, training certificates).
//
// Files are kept in data/uploads with random names, NOT in the public folder,
// so only logged-in users can download them.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const config = require('./config');

const MAX_FILE_MB = 10;
const ALLOWED_EXTENSIONS = [
  '.pdf', '.doc', '.docx', '.odt', '.xls', '.xlsx', '.csv', '.txt', '.png', '.jpg', '.jpeg', '.gif', '.webp',
];

// Reads an uploaded file (form field name "file") into memory. Nothing is
// written to disk until the form has been checked and saveUpload() is called.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 1, fields: 200 },
}).single('file');

class UploadError extends Error {}

// Returns { file_name, file_original } or null if no file was chosen.
function saveUpload(file) {
  if (!file || !file.size) return null;
  const ext = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    throw new UploadError(`That type of file isn't allowed. Allowed types: ${ALLOWED_EXTENSIONS.join(', ')}`);
  }
  const storedName = crypto.randomBytes(16).toString('hex') + ext;
  fs.writeFileSync(path.join(config.uploadsDir, storedName), file.buffer);
  return { file_name: storedName, file_original: path.basename(file.originalname).slice(0, 200) };
}

function deleteUpload(storedName) {
  if (storedName) fs.rmSync(path.join(config.uploadsDir, path.basename(storedName)), { force: true });
}

function sendUpload(res, storedName, originalName) {
  const filePath = path.join(config.uploadsDir, path.basename(storedName));
  if (!fs.existsSync(filePath)) {
    return res.status(404).render('error', { title: 'File missing', message: 'That file could not be found.' });
  }
  res.download(filePath, originalName || storedName);
}

module.exports = { upload, saveUpload, deleteUpload, sendUpload, UploadError, MAX_FILE_MB };
