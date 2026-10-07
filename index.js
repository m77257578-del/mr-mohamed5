const { vercelHandler } = require('../server');

module.exports = vercelHandler;
module.exports.config = { api: { bodyParser: false } };