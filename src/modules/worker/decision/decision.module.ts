import { Module } from '@nestjs/common';
import { ApplicationsDataModule } from '../../../shared/applications/applications-data.module';
import { VerificationModule } from '../verification/verification.module';
import { DecisionConsumer } from './decision.consumer';
import { DecisionService } from './decision.service';

@Module({
  imports: [ApplicationsDataModule, VerificationModule],
  providers: [
    { provide: DecisionService, useFactory: () => new DecisionService() },
    DecisionConsumer,
  ],
})
export class DecisionModule {}
