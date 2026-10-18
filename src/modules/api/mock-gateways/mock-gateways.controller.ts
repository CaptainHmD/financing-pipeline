import { Body, Controller, Get, Headers, HttpCode, Post, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  NafathVerifyRequestDto,
  SimahReportRequestDto,
  WathiqStatusRequestDto,
} from './dto/mock-requests.dto';
import { MockGatewaysService, MockReply } from './mock-gateways.service';
import { NAFATH_SCENARIOS, SIMAH_SCENARIOS, WATHIQ_SCENARIOS } from './scenarios';

/** Stand-ins for the external Saudi gateways. Not part of the product API. */
@ApiTags('mock-gateways')
@SkipThrottle()
@Controller('mock')
export class MockGatewaysController {
  constructor(private readonly mocks: MockGatewaysService) {}

  @Get('scenarios')
  @ApiOperation({ summary: 'List the magic-digit scenarios each mock supports' })
  scenarios() {
    return {
      nafath: { selector: 'last digit of nationalId', scenarios: NAFATH_SCENARIOS },
      wathiq: { selector: 'last digit of crNumber', scenarios: WATHIQ_SCENARIOS },
      simah: { selector: 'second-to-last digit of nationalId', scenarios: SIMAH_SCENARIOS },
    };
  }

  @Post('nafath/verify')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mock Nafath / Yakeen identity verification' })
  nafath(
    @Body() body: NafathVerifyRequestDto,
    @Headers('x-correlation-id') correlationId = 'none',
    @Res() res: Response,
  ) {
    return send(res, this.mocks.nafath(body.nationalId, correlationId));
  }

  @Post('wathiq/cr-status')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mock Wathiq commercial registration status' })
  wathiq(
    @Body() body: WathiqStatusRequestDto,
    @Headers('x-correlation-id') correlationId = 'none',
    @Res() res: Response,
  ) {
    return send(res, this.mocks.wathiq(body.crNumber, correlationId));
  }

  @Post('simah/credit-report')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mock SIMAH credit report' })
  simah(
    @Body() body: SimahReportRequestDto,
    @Headers('x-correlation-id') correlationId = 'none',
    @Res() res: Response,
  ) {
    return send(res, this.mocks.simah(body.nationalId, correlationId));
  }
}

async function send(res: Response, reply: MockReply): Promise<void> {
  if (reply.delayMs) await sleep(reply.delayMs);
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  if (typeof reply.body === 'string') {
    res.status(reply.status).type('text/html').send(reply.body);
  } else {
    res.status(reply.status).json(reply.body);
  }
}
