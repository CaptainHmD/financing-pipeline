import { NestFactory } from '@nestjs/core';
import { AppConfigService } from '../../shared/config/app-config.service';
import { AppModule } from './app.module';
import { setupApp } from './setup-app';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  setupApp(app);
  await app.listen(app.get(AppConfigService).get('PORT'));
}

void bootstrap();
