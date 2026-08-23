import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import zlib from 'node:zlib';

const dist = path.join(process.cwd(), 'dist');
const assets = path.join(dist, 'assets');
const JS_GZIP_BUDGET = 130 * 1024;
const CSS_GZIP_BUDGET = 20 * 1024;

if (!fs.existsSync(assets)) {
  console.error('Bundle budget: dist/assets is missing. Run the production build first.');
  process.exit(1);
}

const files = fs.readdirSync(assets);
const measure = (extension) => files
  .filter((name) => name.endsWith(extension))
  .map((name) => {
    const bytes = fs.readFileSync(path.join(assets, name));
    return { name, raw: bytes.length, gzip: zlib.gzipSync(bytes).length };
  });

const js = measure('.js');
const css = measure('.css');
const total = (items, key) => items.reduce((sum, item) => sum + item[key], 0);
const jsGzip = total(js, 'gzip');
const cssGzip = total(css, 'gzip');

console.log(`Bundle budget: JS gzip ${(jsGzip / 1024).toFixed(1)} KiB / ${(JS_GZIP_BUDGET / 1024).toFixed(0)} KiB`);
console.log(`Bundle budget: CSS gzip ${(cssGzip / 1024).toFixed(1)} KiB / ${(CSS_GZIP_BUDGET / 1024).toFixed(0)} KiB`);

const failures = [];
if (jsGzip > JS_GZIP_BUDGET) failures.push(`JavaScript gzip budget exceeded by ${((jsGzip - JS_GZIP_BUDGET) / 1024).toFixed(1)} KiB`);
if (cssGzip > CSS_GZIP_BUDGET) failures.push(`CSS gzip budget exceeded by ${((cssGzip - CSS_GZIP_BUDGET) / 1024).toFixed(1)} KiB`);

if (failures.length) {
  console.error('Mobile-first bundle budget failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error('Keep the Multi Chat Remote control plane lightweight; lazy-load secondary centers before raising the budget.');
  process.exit(1);
}

console.log('Bundle budget: within mobile-first limits.');
