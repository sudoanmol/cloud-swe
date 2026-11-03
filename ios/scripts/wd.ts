/**
 * Path: ios/scripts/wd.ts
 * Used by: none; run by hand (AGENTS.md, iOS client).
 * Purpose: A tiny WebDriver client that drives the app on the iOS Simulator through Appium on port 4723.
 */

// node ios/scripts/wd.ts start | shot <png> | tap <x> <y> | swipe <x1> <y1> <x2> <y2> [ms] | act <json> | stop
// Coordinates are points, not pixels. The session id is kept in wd.sid next to this file.
import { readFileSync, writeFileSync } from 'node:fs';

import { z } from 'zod';

type WebDriverRequest = { method: 'GET' | 'POST' | 'DELETE'; path: string; body?: object };

const Failure = z.object({ value: z.object({ message: z.string() }) });
const NewSession = z.object({ sessionId: z.string() });

const server = 'http://127.0.0.1:4723';
const sidFile = new URL('wd.sid', import.meta.url);

async function call<T extends z.ZodType>({ method, path, body }: WebDriverRequest, value: T): Promise<z.infer<T>> {
  const response = await fetch(server + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(Number(process.env.WD_TIMEOUT ?? 40_000)),
  });

  const json: unknown = await response.json().catch(() => ({}));

  if (!response.ok) {
    const failure = Failure.safeParse(json);

    throw new Error(
      `${method} ${path}: ${failure.success ? failure.data.value.message.slice(0, 300) : response.status}`,
    );
  }

  return z.object({ value }).parse(json).value;
}

const [command, ...args] = process.argv.slice(2);

function arg(index: number): string {
  const value = args[index];

  if (value === undefined) throw new Error(`${command}: missing argument ${index + 1}`);

  return value;
}

if (command === 'start') {
  const udid = process.env.WD_UDID;

  if (!udid) throw new Error('set WD_UDID to a booted Simulator (xcrun simctl list devices booted)');

  const alwaysMatch = {
    platformName: 'iOS',
    'appium:automationName': 'XCUITest',
    'appium:bundleId': process.env.WD_BUNDLE ?? 'com.anmolhurkat.CloudSWE',
    'appium:autoLaunch': false,
    'appium:udid': udid,
    'appium:noReset': true,
    'appium:newCommandTimeout': 3600,
  };

  const session = await call({ method: 'POST', path: '/session', body: { capabilities: { alwaysMatch } } }, NewSession);

  writeFileSync(sidFile, session.sessionId);
  process.stdout.write(`${session.sessionId}\n`);
} else {
  const session = `/session/${readFileSync(sidFile, 'utf8').trim()}`;

  const touch = (steps: object[]) =>
    call(
      {
        method: 'POST',
        path: `${session}/actions`,
        body: { actions: [{ type: 'pointer', id: 'finger', parameters: { pointerType: 'touch' }, actions: steps }] },
      },
      z.unknown(),
    );

  const press = (x: string, y: string) => [
    { type: 'pointerMove', duration: 0, x: Number(x), y: Number(y) },
    { type: 'pointerDown', button: 0 },
  ];

  switch (command) {
    case 'shot': {
      const png = await call({ method: 'GET', path: `${session}/screenshot` }, z.string());

      writeFileSync(arg(0), Buffer.from(png, 'base64'));
      process.stdout.write(`${arg(0)}\n`);

      break;
    }

    case 'tap':
      await touch([...press(arg(0), arg(1)), { type: 'pause', duration: 60 }, { type: 'pointerUp', button: 0 }]);

      break;
    case 'swipe': {
      const move = { type: 'pointerMove', duration: Number(args[4] ?? 250), x: Number(arg(2)), y: Number(arg(3)) };

      await touch([...press(arg(0), arg(1)), move, { type: 'pointerUp', button: 0 }]);

      break;
    }

    case 'act': // raw W3C actions: several fingers, long holds, typing
      await call({ method: 'POST', path: `${session}/actions`, body: { actions: JSON.parse(arg(0)) } }, z.unknown());

      break;
    case 'stop':
      await call({ method: 'DELETE', path: session }, z.unknown());

      break;
    default:
      throw new Error(`unknown command ${command}`);
  }
}
