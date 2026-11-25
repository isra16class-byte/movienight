// Artefactos versionados: el servidor no necesita devDependencies ni bundler.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.join(__dirname, '..');
const output = path.join(root, 'public/fonts');
const families = { monoton: [400], 'space-grotesk': [400, 500, 600, 700], vt323: [400] };
const artifacts = new Map();
const styles = ['/* Generado por npm run fonts:build. Licencias OFL junto a las fuentes. */'];
for (const [id, weights] of Object.entries(families)) {
  const packageRoot = path.dirname(require.resolve(`@fontsource/${id}/package.json`));
  const { version } = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  styles.push(`/* @fontsource/${id}@${version} */`);
  artifacts.set(`LICENSE-${id}.txt`, fs.readFileSync(path.join(packageRoot, 'LICENSE')));
  for (const weight of weights) {
    const css = fs.readFileSync(path.join(packageRoot, `${weight}.css`), 'utf8').replace(/\r\n/g, '\n');
    styles.push(css.replace(/src:\s*[^;]+;/g, declaration => {
      const match = declaration.match(/url\(\.\/files\/([\w-]+\.woff2)\) format\('woff2'\)/);
      if (!match) throw new Error(`No se encontró WOFF2 para ${id}/${weight}`);
      const bytes = fs.readFileSync(path.join(packageRoot, 'files', match[1]));
      if (bytes.toString('ascii', 0, 4) !== 'wOF2') throw new Error(`WOFF2 inválido: ${match[1]}`);
      const hash = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 12);
      const name = match[1].replace('.woff2', `.${hash}.woff2`);
      artifacts.set(name, bytes);
      return `src: url('./${name}') format('woff2');`;
    }));
  }
}
artifacts.set('fonts.css', Buffer.from(styles.join('\n\n') + '\n'));
const swPath = path.join(root, 'public/sw.js');
const sw = fs.readFileSync(swPath, 'utf8').replace(/\r\n/g, '\n');
const marker = / {2}\/\/ BEGIN FONT ASSETS[\s\S]*? {2}\/\/ END FONT ASSETS/;
if (!marker.test(sw)) throw new Error('Falta el bloque de fuentes del service worker');
const fontUrls = [...artifacts.keys()].filter(name => name.endsWith('.woff2')).sort();
const updatedSw = sw.replace(marker, [
  '  // BEGIN FONT ASSETS — generado por npm run fonts:build',
  ...fontUrls.map(name => `  '/fonts/${name}',`),
  '  // END FONT ASSETS',
].join('\n'));
if (process.argv.includes('--check')) {
  for (const [name, content] of artifacts) {
    const target = path.join(output, name);
    const actual = fs.existsSync(target) ? fs.readFileSync(target) : null;
    const matches = actual && (name.endsWith('.woff2') ? actual.equals(content)
      : actual.toString('utf8').replace(/\r\n/g, '\n') === content.toString('utf8').replace(/\r\n/g, '\n'));
    if (!matches) throw new Error(`Regenerá las fuentes: ${name}`);
  }
  if (sw !== updatedSw) throw new Error('Regenerá la lista de fuentes del service worker');
} else {
  fs.mkdirSync(output, { recursive: true });
  for (const [name, content] of artifacts) fs.writeFileSync(path.join(output, name), content);
  fs.writeFileSync(swPath, updatedSw);
}
console.log(`${fontUrls.length} WOFF2 y sus licencias/CSS ${process.argv.includes('--check') ? 'verificados' : 'exportados'}.`);
