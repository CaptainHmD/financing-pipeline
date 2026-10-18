import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

export class NafathVerifyRequestDto {
  @ApiProperty({ example: '1012345670' })
  @IsString()
  @Matches(/^\d{10}$/)
  nationalId: string;
}

export class WathiqStatusRequestDto {
  @ApiProperty({ example: '7001234560' })
  @IsString()
  @Matches(/^\d{10}$/)
  crNumber: string;
}

export class SimahReportRequestDto {
  @ApiProperty({ example: '1012345670' })
  @IsString()
  @Matches(/^\d{10}$/)
  nationalId: string;

  @ApiProperty({ example: '7001234560' })
  @IsString()
  @Matches(/^\d{10}$/)
  crNumber: string;
}
