import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ApplicationRecord,
  ApplicationStatus,
  CheckStatus,
  CheckType,
  Decision,
} from '../../../../shared/applications/application.types';
import { maskIdentifier } from '../../../../shared/util/mask';

export class CheckSummaryDto {
  @ApiProperty({ enum: CheckType })
  type: CheckType;

  @ApiProperty({ enum: CheckStatus })
  status: CheckStatus;

  @ApiProperty()
  attempts: number;

  @ApiPropertyOptional({ nullable: true, example: 'CR_EXPIRED' })
  reasonCode: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'HTTP_503' })
  lastError: string | null;

  @ApiPropertyOptional({ nullable: true })
  latencyMs: number | null;

  @ApiPropertyOptional({ nullable: true })
  completedAt: Date | null;
}

/** Public representation: PII is always masked. */
export class ApplicationResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: ApplicationStatus })
  status: ApplicationStatus;

  @ApiPropertyOptional({ enum: Decision, nullable: true })
  decision: Decision | null;

  @ApiProperty({ type: [String], example: ['ALL_CHECKS_PASSED'] })
  decisionReasons: string[];

  @ApiProperty({ example: '1*******70' })
  nationalId: string;

  @ApiProperty({ example: '7*******60' })
  crNumber: string;

  @ApiProperty({ example: 250000 })
  requestedAmount: number;

  @ApiProperty({ type: [CheckSummaryDto] })
  checks: CheckSummaryDto[];

  @ApiPropertyOptional({ nullable: true })
  decidedAt: Date | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;

  static from(record: ApplicationRecord): ApplicationResponseDto {
    return {
      id: record.id,
      status: record.status,
      decision: record.decision,
      decisionReasons: record.decisionReasons,
      nationalId: maskIdentifier(record.nationalId),
      crNumber: maskIdentifier(record.crNumber),
      requestedAmount: record.requestedAmount,
      checks: record.checks,
      decidedAt: record.decidedAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }
}

export class AuditEventDto {
  @ApiProperty({ example: 'CHECK_RETRY_SCHEDULED' })
  event: string;

  @ApiProperty({ example: { checkType: 'credit', attempt: 1, error: 'HTTP_503' } })
  metadata: unknown;

  @ApiProperty()
  createdAt: Date;
}
