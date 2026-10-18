import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { TokenRequestDto, TokenResponseDto } from './dto/token-request.dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('token')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Issue a short-lived JWT (demo client-credentials flow)' })
  @ApiOkResponse({ type: TokenResponseDto })
  issue(@Body() body: TokenRequestDto): Promise<TokenResponseDto> {
    return this.auth.issueToken(body.clientId, body.clientSecret);
  }
}
