import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Resolve paths relative to THIS file, so it works no matter where you run
// `node` / `nodemon` from (project root or backend/ folder).
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 1) project-root .env (as in README)   2) backend/.env (optional)
// dotenv never overwrites a variable that is already set, so the first one wins.
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '.env') });
