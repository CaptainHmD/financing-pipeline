import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppConfigService } from './config/app-config.service';
import { validateEnv } from './config/env.validation';
import { CryptoService } from './crypto/crypto.service';
import { OutboxService } from './messaging/outbox.service';
import { RabbitMqService } from './messaging/rabbitmq.service';
import { PrismaService } from './prisma/prisma.service';

/** Infrastructure shared by the API and the worker processes. */
@Global()
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateEnv, cache: true })],
  providers: [AppConfigService, PrismaService, CryptoService, RabbitMqService, OutboxService],
  exports: [AppConfigService, PrismaService, CryptoService, RabbitMqService, OutboxService],
})
export class CoreModule {}
