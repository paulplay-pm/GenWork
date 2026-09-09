// Test bootstrap for shared test helpers.
// Tests can import from here; ensures DATABASE_URL/JWT_SECRET are set before
// the pool module is loaded.
process.env.GENWORK_VAULT_MASTER_KEY ??= 'A'.repeat(43) + '=';
process.env.JWT_SECRET ??= 'a'.repeat(40);
process.env.DATABASE_URL ??= 'postgres://test/test';