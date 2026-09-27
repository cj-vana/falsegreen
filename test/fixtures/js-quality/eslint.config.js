import js from '@eslint/js';

// Only JavaScript files are configured, so ESLint never looks at the TypeScript sources.
export default [{ files: ['**/*.js'], ...js.configs.recommended }];
