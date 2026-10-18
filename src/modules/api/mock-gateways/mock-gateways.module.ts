import { Module } from '@nestjs/common';
import { MockGatewaysController } from './mock-gateways.controller';
import { MockGatewaysService } from './mock-gateways.service';

@Module({
  controllers: [MockGatewaysController],
  providers: [MockGatewaysService],
})
export class MockGatewaysModule {}
