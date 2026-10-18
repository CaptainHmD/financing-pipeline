import { Module } from '@nestjs/common';
import { DecisionModule } from '../../modules/worker/decision/decision.module';
import { VerificationModule } from '../../modules/worker/verification/verification.module';
import { CoreModule } from '../../shared/core.module';
import { OutboxRelay } from './outbox.relay';

/** Background worker process: consumes the pipeline events and runs the outbox relay. */
@Module({
  imports: [CoreModule, VerificationModule, DecisionModule],
  providers: [OutboxRelay],
})
export class WorkerModule {}
