const fs = require('node:fs');
const path = require('node:path');
const assets = require('../server/public-assets');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'public');
const marker = path.join(output, '.generated-by-build-vercel');

if (fs.existsSync(output)) {
  if (!fs.existsSync(marker)) {
    throw new Error('Refusing to replace a public directory not created by build-vercel.');
  }
  fs.rmSync(output, { recursive: true });
}
fs.mkdirSync(output);
fs.writeFileSync(marker, 'Generated from server/public-assets.js.\n');

for (const asset of assets) {
  const source = path.resolve(root, asset);
  const destination = path.resolve(output, asset);
  if (!source.startsWith(root + path.sep) || !destination.startsWith(output + path.sep)) {
    throw new Error(`Invalid public asset path: ${asset}`);
  }
  if (!fs.statSync(source).isFile()) throw new Error(`Missing public asset: ${asset}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

console.log(`Copied ${assets.length} allowlisted browser assets to public/.`);
