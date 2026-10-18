import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../../../shared/config/app-config.service';
import { TransientGatewayError } from './gateway.types';

export interface GatewayHttpResponse {
  status: number;
  /** Parsed JSON body, or undefined when the body was not valid JSON. */
  body: unknown;
}

export interface GatewayRequest {
  provider: string;
  path: string;
  payload: unknown;
  timeoutMs: number;
  correlationId: string;
}

/**
 * Single HTTP call with a hard timeout. Classifies transport-level problems as transient
 * (thrown) and hands any other response back to the adapter to interpret.
 * Deliberately no in-process retry loop: retries go through RabbitMQ delay queues so they survive restarts.
 */
@Injectable()
export class HttpGatewayClient {
  constructor(private readonly config: AppConfigService) {}

  async post(req: GatewayRequest): Promise<GatewayHttpResponse> {
    let res: Response;
    let text: string;
    try {
      res = await fetch(`${this.config.get('GATEWAY_BASE_URL')}${req.path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'x-correlation-id': req.correlationId,
        },
        body: JSON.stringify(req.payload),
        signal: AbortSignal.timeout(req.timeoutMs),
      });
      text = await res.text();
    } catch (err) {
      const name = (err as Error).name;
      const code = name === 'TimeoutError' || name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR';
      throw new TransientGatewayError(req.provider, code);
    }

    if (res.status >= 500 || res.status === 429 || res.status === 408) {
      throw new TransientGatewayError(req.provider, `HTTP_${res.status}`);
    }

    return { status: res.status, body: parseJson(text) };
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
