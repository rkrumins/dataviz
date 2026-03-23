import crypto from 'crypto';

/**
 * CLI utility to generate secure authentication credentials for Nexus Lineage.
 * Usage: node scripts/generate-auth.js <username> <password>
 */

const username = process.argv[2];
const password = process.argv[3];

if (!username || !password) {
    console.log('\x1b[31mError: Missing arguments\x1b[0m');
    console.log('Usage: npm run gen-auth <username> <password>');
    process.exit(1);
}

const hash = crypto.createHash('sha256').update(password).digest('hex');

console.log('\n\x1b[32m✨ Secure Credentials Generated! ✨\x1b[0m');
console.log('-------------------------------------------');
console.log('Copy and paste the following into your \x1b[36m.env\x1b[0m file:\n');
console.log(`\x1b[1mVITE_AUTH_USERNAME=${username}\x1b[0m`);
console.log(`\x1b[1mVITE_AUTH_PASSWORD_HASH=${hash}\x1b[0m`);
console.log('-------------------------------------------');
console.log('\x1b[33mNote:\x1b[0m Restart your dev server after updating the .env file.\n');
