// Starts the web server on your computer. Run it with "npm start", which also
// starts the local database first. (On Netlify, netlify/functions/app.mjs is used instead.)
const app = require('./app');
const config = require('./config');

app.listen(config.port, () => {
  console.log(`Admin site running at http://localhost:${config.port}`);
  console.log(`Local data is stored in ${config.dataDir}`);
});
