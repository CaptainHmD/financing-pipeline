import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { AppConfigService } from '../../shared/config/app-config.service';
import { OutboxService } from '../../shared/messaging/outbox.service';

const RETENTION_MS = 7 * 24 * 3600 * 1000;

/** Delivers outbox events that were not published at write time. Runs in the worker process only. */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelay.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly outbox: OutboxService,
    private readonly config: AppConfigService,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.run(), this.config.get('OUTBOX_RELAY_INTERVAL_MS'));
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const published = await this.outbox.relayPending(this.config.get('OUTBOX_RELAY_AFTER_MS'));
      if (published > 0) this.logger.log(`Relayed ${published} pending event(s)`);
      await this.outbox.purgePublished(new Date(Date.now() - RETENTION_MS));
    } catch (err) {
      this.logger.error(`Outbox relay failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
