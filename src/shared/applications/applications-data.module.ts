import { Module } from '@nestjs/common';
import { ApplicationsRepository } from './applications.repository';

/** Persistence of the Application aggregate, shared by the API and the worker. */
@Module({
  providers: [ApplicationsRepository],
  exports: [ApplicationsRepository],
})
export class ApplicationsDataModule {}
