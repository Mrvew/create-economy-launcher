// Writes build-time settings (from environment variables) into src/main/baked.json,
// so release builds have the Azure client id without it being in the source code.
const fs = require('fs');
const path = require('path');
const out = {
  MS_CLIENT_ID: process.env.CE_MS_CLIENT_ID || '',
};
fs.writeFileSync(path.join(__dirname, '..', 'src', 'main', 'baked.json'), JSON.stringify(out, null, 1));
console.log('baked config:', Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v ? 'set' : 'empty'])));
