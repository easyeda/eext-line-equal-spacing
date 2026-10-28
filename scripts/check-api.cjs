const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

// Skill linter 2.0.0 omits this Set declaration. Repair only the in-memory copy.
const sourcePath = path.join(process.env.USERPROFILE, '.agents/skills/extension-dev-skill/scripts/lint-eda-api.js');
const source = fs.readFileSync(sourcePath, 'utf8').replace(
	'_checkUndefinedFunctions(source, lines) {',
	'_checkUndefinedFunctions(source, lines) { const defined = new Set();',
);
const instance = new Module(sourcePath, module);
instance.filename = sourcePath;
instance.paths = Module._nodeModulePaths(path.dirname(sourcePath));
process.argv = [process.execPath, sourcePath, 'src/'];
instance._compile(source, sourcePath);
