const Module = require('node:module');
const path = require('node:path');
const esbuild = require('esbuild');

function loadTs(relativeEntry, mocks = {}) {
  const entry = path.resolve(__dirname, '../..', relativeEntry);
  const code = esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    external: Object.keys(mocks),
  }).outputFiles[0].text;
  const loaded = new Module(entry, module);
  const originalRequire = loaded.require.bind(loaded);
  loaded.require = (id) => (id in mocks ? mocks[id] : originalRequire(id));
  loaded._compile(code, entry);
  return loaded.exports;
}

module.exports = { loadTs };
