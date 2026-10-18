import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ApplicationsModule } from '../../modules/api/applications/applications.module';
import { AuthModule } from '../../modules/api/auth/auth.module';
import { MockGatewaysModule } from '../../modules/api/mock-gateways/mock-gateways.module';
import { CoreModule } from '../../shared/core.module';
import { HealthController } from './health.controller';
import { RequestLoggingInterceptor } from './request-logging.interceptor';

/** HTTP API process: accepts applications and serves status. Never calls external gateways. */
@Module({
  imports: [
    CoreModule,
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    AuthModule,
    ApplicationsModule,
    MockGatewaysModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_INTERCEPTOR, useClass: RequestLoggingInterceptor },
  ],
})
export class AppModule {}
