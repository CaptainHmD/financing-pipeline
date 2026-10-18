import { INestApplication, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';

/** Shared HTTP setup, used by main.ts and the e2e tests (importing main.ts would start the server). */
export function setupApp(app: INestApplication): void {
  app.use(helmet());
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.enableShutdownHooks();

  const config = new DocumentBuilder()
    .setTitle('Financing API')
    .setDescription(
      'Submit financing applications and track the asynchronous verification pipeline ' +
        '(Nafath/Yakeen, Wathiq, SIMAH - mocked). See GET /mock/scenarios for failure scenarios.',
    )
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config), {
    jsonDocumentUrl: 'docs/openapi.json',
  });
}
