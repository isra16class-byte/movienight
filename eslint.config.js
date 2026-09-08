// Config de ESLint (Fase 5 del plan de producción: "CI con lint").
//
// A propósito acotado: cubre el código de servidor (server.js, lib/, scripts/, test/), que es
// CommonJS y corre en Node. Deliberadamente NO cubre public/ (el JS de cliente vive inline dentro
// de los .html, sin un build step ni bundler — meterlo acá implicaría separar ese JS a archivos
// .js propios primero, que es un cambio de otro alcance, no de "agregar lint").
//
// Reglas: se parte de `@eslint/js` recommended (los errores reales: variables no declaradas, casos
// de switch que caen mal, etc.) y se suma `no-unused-vars` con un escape hatch para argumentos que
// empiezan con `_` (patrón ya usado en callbacks de Node tipo `(err, _res) => ...`). Nada de estilo
// (comillas, punto y coma, etc.) — el proyecto no usaba Prettier ni una convención de estilo
// enforced hasta ahora, y sumarla acá sería un cambio aparte con un diff enorme, no "agregar lint".

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: ['node_modules/**', 'public/**', 'docs/**'],
  },
  js.configs.recommended,
  {
    files: ['server.js', 'lib/**/*.js', 'scripts/**/*.js', 'ecosystem.config.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
  },
];
