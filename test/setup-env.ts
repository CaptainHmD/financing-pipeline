import { E2E_ENV } from './e2e-env';

// Runs before each test file is loaded, so ConfigModule validates these values.
Object.assign(process.env, E2E_ENV);
