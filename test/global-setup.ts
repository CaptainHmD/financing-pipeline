import { execSync } from 'node:child_process';
import { E2E_ENV } from './e2e-env';

/**
 * Applies the migrations to the e2e database once per run. Non-destructive: the database lives in
 * the throwaway e2e stack (npm run e2e:down wipes it) and every test uses fresh random identifiers,
 * so data left over from earlier runs never interferes.
 */
export default function globalSetup(): void {
  try {
    execSync('npx prisma migrate deploy', {
      env: { ...process.env, DATABASE_URL: E2E_ENV.DATABASE_URL },
      stdio: 'pipe',
    });
  } catch (err) {
    const output = (err as { stderr?: Buffer }).stderr?.toString() ?? String(err);
    throw new Error(
      `Could not migrate the e2e database. Is the e2e stack running? (npm run e2e:up)\n${output}`,
    );
  }
}
