import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, timingSafeEqual } from 'node:crypto';
import { AppConfigService } from '../../../shared/config/app-config.service';
import { TokenResponseDto } from './dto/token-request.dto';

export interface AuthenticatedClient {
  clientId: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Demo client-credentials issuer. In production tokens would come from the platform IdP
   * (and the applicant identity from Nafath); this endpoint is disabled unless ENABLE_DEMO_AUTH=true.
   */
  async issueToken(clientId: string, clientSecret: string): Promise<TokenResponseDto> {
    if (!this.config.get('ENABLE_DEMO_AUTH')) {
      throw new NotFoundException();
    }
    const validId = safeEqual(clientId, this.config.get('DEMO_CLIENT_ID'));
    const validSecret = safeEqual(clientSecret, this.config.get('DEMO_CLIENT_SECRET'));
    if (!validId || !validSecret) {
      throw new UnauthorizedException('Invalid client credentials');
    }
    const expiresIn = this.config.get('JWT_TTL_SECONDS');
    const accessToken = await this.jwt.signAsync({ sub: clientId }, { expiresIn });
    return { accessToken, tokenType: 'Bearer', expiresIn };
  }

  async verify(token: string): Promise<AuthenticatedClient> {
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string }>(token);
      return { clientId: payload.sub };
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}

/** Constant-time comparison (hashing first equalises lengths). */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return b.length > 0 && timingSafeEqual(ha, hb);
}
