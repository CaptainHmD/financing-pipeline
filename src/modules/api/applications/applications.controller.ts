import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import type { AuthenticatedClient } from '../auth/auth.service';
import { CurrentClient } from '../auth/current-client.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ApplicationsService } from './applications.service';
import { ApplicationResponseDto, AuditEventDto } from './dto/application-response.dto';
import { CreateApplicationDto } from './dto/create-application.dto';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

@ApiTags('applications')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token' })
@UseGuards(JwtAuthGuard)
@Controller('applications')
export class ApplicationsController {
  constructor(private readonly applications: ApplicationsService) {}

  @Post()
  @HttpCode(202)
  @ApiOperation({
    summary: 'Submit a financing application',
    description:
      'Persists the application and starts the asynchronous verification pipeline. ' +
      'Poll GET /applications/{id} for the decision.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Client-generated unique key (8-128 chars). Retrying with the same key is safe.',
  })
  @ApiAcceptedResponse({ type: ApplicationResponseDto })
  @ApiConflictResponse({
    description: 'Key reused with a different payload, or an application is already in progress',
  })
  async submit(
    @CurrentClient() client: AuthenticatedClient,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CreateApplicationDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApplicationResponseDto> {
    if (!idempotencyKey || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      throw new BadRequestException('A valid Idempotency-Key header is required');
    }
    const { application, replayed } = await this.applications.submit(
      client.clientId,
      idempotencyKey,
      dto,
    );
    res.setHeader('Location', `/applications/${application.id}`);
    if (replayed) res.setHeader('Idempotent-Replayed', 'true');
    return ApplicationResponseDto.from(application);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get application status, decision and per-check results' })
  @ApiOkResponse({ type: ApplicationResponseDto })
  @ApiNotFoundResponse()
  async get(
    @CurrentClient() client: AuthenticatedClient,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<ApplicationResponseDto> {
    return ApplicationResponseDto.from(await this.applications.get(id, client.clientId));
  }

  @Get(':id/events')
  @ApiOperation({ summary: 'Audit trail: submission, retries, check outcomes and decision' })
  @ApiOkResponse({ type: [AuditEventDto] })
  @ApiNotFoundResponse()
  events(
    @CurrentClient() client: AuthenticatedClient,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<AuditEventDto[]> {
    return this.applications.events(id, client.clientId);
  }
}
