/**
 * Environment for the e2e suite. Points at docker-compose.e2e.yml and shortens every timeout and
 * backoff so the slow and failing provider scenarios settle in about a second.
 * Values set here take precedence over the developer's .env.
 */
export const E2E_PORT = 3999;

export const E2E_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  PORT: String(E2E_PORT),
  DATABASE_URL: 'postgresql://app:app@localhost:5433/app_e2e?schema=public',
  RABBITMQ_URL: 'amqp://app:app@localhost:5673',
  RABBITMQ_PUBLISH_TIMEOUT_MS: '1000',
  JWT_SECRET: 'e2e-secret-that-is-at-least-thirty-two-characters',
  JWT_TTL_SECONDS: '900',
  ENABLE_DEMO_AUTH: 'true',
  DEMO_CLIENT_ID: 'e2e-client',
  DEMO_CLIENT_SECRET: 'e2e-client-secret',
  ENCRYPTION_KEY: 'vKLJGmbHQXIO9mHvja+cOjna2CV0nlb+UY/AbmMk4hc=',
  BLIND_INDEX_KEY: 'cLOrZyP33xzSzAGhoBqTNbVRnr5tBR5co9tiA17VfmE=',
  // The worker calls the mocks served by the API under test.
  GATEWAY_BASE_URL: `http://localhost:${E2E_PORT}/mock`,
  GATEWAY_TIMEOUT_MS: '1000',
  WATHIQ_TIMEOUT_MS: '300',
  MOCK_SLOW_RESPONSE_MS: '600',
  MOCK_CHAOS_RATE: '0',
  // 3 attempts is exactly what the "503 twice, then OK" scenarios need.
  RETRY_ATTEMPTS: '3',
  RETRY_BACKOFF_MS: '100',
  CIRCUIT_BREAKER_FAILURE_THRESHOLD: '4',
  CIRCUIT_BREAKER_COOLDOWN_MS: '1000',
  OUTBOX_RELAY_INTERVAL_MS: '200',
  OUTBOX_RELAY_AFTER_MS: '500',
};
