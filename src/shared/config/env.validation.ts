import { plainToInstance, Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsString,
  IsUrl,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

const toBool = ({ value }: { value: unknown }) => value === true || value === 'true';

export class EnvironmentVariables {
  @IsIn(['development', 'test', 'production'])
  NODE_ENV: string = 'development';

  @IsInt()
  PORT: number = 3001;

  @IsString()
  DATABASE_URL: string;

  @IsUrl({ protocols: ['amqp', 'amqps'], require_tld: false, require_protocol: true })
  RABBITMQ_URL: string;

  @IsInt()
  @Min(100)
  RABBITMQ_PUBLISH_TIMEOUT_MS: number = 2000;

  @IsString()
  @MinLength(32)
  JWT_SECRET: string;

  @IsInt()
  @Min(60)
  JWT_TTL_SECONDS: number = 900;

  @Transform(toBool)
  @IsBoolean()
  ENABLE_DEMO_AUTH: boolean = false;

  @IsString()
  DEMO_CLIENT_ID: string = '';

  @IsString()
  DEMO_CLIENT_SECRET: string = '';

  @IsString()
  ENCRYPTION_KEY: string;

  @IsString()
  BLIND_INDEX_KEY: string;

  @IsUrl({ require_tld: false })
  GATEWAY_BASE_URL: string;

  @IsInt()
  @Min(100)
  GATEWAY_TIMEOUT_MS: number = 5000;

  @IsInt()
  @Min(100)
  WATHIQ_TIMEOUT_MS: number = 3000;

  @IsInt()
  @Min(1)
  @Max(20)
  RETRY_ATTEMPTS: number = 5;

  @IsInt()
  @Min(10)
  RETRY_BACKOFF_MS: number = 2000;

  @IsInt()
  @Min(1)
  CIRCUIT_BREAKER_FAILURE_THRESHOLD: number = 5;

  @IsInt()
  @Min(100)
  CIRCUIT_BREAKER_COOLDOWN_MS: number = 10000;

  @IsInt()
  @Min(100)
  OUTBOX_RELAY_INTERVAL_MS: number = 5000;

  @IsInt()
  @Min(0)
  OUTBOX_RELAY_AFTER_MS: number = 5000;

  @IsInt()
  @Min(0)
  MOCK_SLOW_RESPONSE_MS: number = 6000;

  @IsNumber()
  @Min(0)
  @Max(1)
  MOCK_CHAOS_RATE: number = 0;
}

export function validateEnv(config: Record<string, unknown>): EnvironmentVariables {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validated, { skipMissingProperties: false });
  if (errors.length > 0) {
    const details = errors.map((e) => Object.values(e.constraints ?? {}).join(', '));
    throw new Error(`Invalid environment configuration: ${details.join('; ')}`);
  }
  return validated;
}
