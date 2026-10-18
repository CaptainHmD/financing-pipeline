import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthenticatedClient } from './auth.service';
import type { AuthenticatedRequest } from './jwt-auth.guard';

export const CurrentClient = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedClient =>
    ctx.switchToHttp().getRequest<AuthenticatedRequest>().client,
);
