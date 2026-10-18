import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';

/**
 * Access log that deliberately never logs bodies, query strings or headers,
 * so National IDs / CR numbers / tokens cannot leak into log storage.
 */
@Injectable()
export class RequestLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const started = Date.now();
    const route = (req.route as { path?: string } | undefined)?.path ?? req.path;
    return next.handle().pipe(
      tap({
        next: () => this.log(req.method, route, http.getResponse<Response>().statusCode, started),
        error: (err: { status?: number }) =>
          this.log(req.method, route, err.status ?? 500, started),
      }),
    );
  }

  private log(method: string, route: string, status: number, started: number): void {
    this.logger.log(`${method} ${route} ${status} ${Date.now() - started}ms`);
  }
}
