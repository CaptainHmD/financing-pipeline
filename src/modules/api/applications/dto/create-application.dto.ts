import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsString, Matches, Max, Min } from 'class-validator';

export class CreateApplicationDto {
  @ApiProperty({
    example: '1012345670',
    description: 'Saudi National ID (starts with 1) or Iqama (starts with 2), 10 digits',
  })
  @IsString()
  @Matches(/^[12]\d{9}$/, { message: 'nationalId must be 10 digits starting with 1 or 2' })
  nationalId: string;

  @ApiProperty({ example: '7001234560', description: 'Commercial Registration number, 10 digits' })
  @IsString()
  @Matches(/^\d{10}$/, { message: 'crNumber must be 10 digits' })
  crNumber: string;

  @ApiProperty({ example: 250000, description: 'Requested financing amount in SAR' })
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(10_000)
  @Max(5_000_000)
  requestedAmount: number;
}
