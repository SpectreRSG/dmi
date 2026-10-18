// Starting point: "npm start" runs this file, which starts the web server.
const app = require('./app');
const config = require('./config');

app.listen(config.port, () => {
  console.log(`Admin site running at http://localhost:${config.port}`);
  console.log(`Data is stored in ${config.dataDir}`);
});
