import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class TokenRequestDto {
  @ApiProperty({ example: 'demo-client' })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  clientId: string;

  @ApiProperty({ example: 'demo-client-secret' })
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  clientSecret: string;
}

export class TokenResponseDto {
  @ApiProperty()
  accessToken: string;

  @ApiProperty({ example: 'Bearer' })
  tokenType: 'Bearer';

  @ApiProperty({ example: 900 })
  expiresIn: number;
}
