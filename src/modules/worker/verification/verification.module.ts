import { Module } from '@nestjs/common';
import { ApplicationsDataModule } from '../../../shared/applications/applications-data.module';
import { CircuitBreakerRegistry } from './gateways/circuit-breaker';
import { CrRegistryGateway } from './gateways/cr-registry.gateway';
import { CreditBureauGateway } from './gateways/credit-bureau.gateway';
import { VERIFICATION_GATEWAYS } from './gateways/gateway.types';
import { HttpGatewayClient } from './gateways/http-gateway.client';
import { IdentityGateway } from './gateways/identity.gateway';
import { VerificationConsumer } from './verification.consumer';
import { VerificationRepository } from './verification.repository';
import { VerificationService } from './verification.service';

@Module({
  imports: [ApplicationsDataModule],
  providers: [
    CircuitBreakerRegistry,
    HttpGatewayClient,
    IdentityGateway,
    CrRegistryGateway,
    CreditBureauGateway,
    {
      // Swapping mocks for real integrations means swapping these adapters (or GATEWAY_BASE_URL).
      provide: VERIFICATION_GATEWAYS,
      inject: [IdentityGateway, CrRegistryGateway, CreditBureauGateway],
      useFactory: (...gateways: unknown[]) => gateways,
    },
    VerificationRepository,
    VerificationService,
    VerificationConsumer,
  ],
  exports: [VerificationRepository],
})
export class VerificationModule {}
