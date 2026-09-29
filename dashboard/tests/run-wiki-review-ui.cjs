const fs = require('node:fs');
const ts = require('typescript');

function transpile(module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText;
  module._compile(output, filename);
}

require.extensions['.ts'] = transpile;
require.extensions['.tsx'] = transpile;
require.extensions['.css'] = (module) => {
  module.exports = new Proxy({}, { get: (_, key) => String(key) });
};

require('./wiki-review-ui.test.ts');
require('./wiki-review-panels.test.tsx');
