import {path as ffmpegPath} from '@ffmpeg-installer/ffmpeg';
import {path as ffprobePath} from '@ffprobe-installer/ffprobe';
import {LogPayload, RendererSettings} from '@motion-canvas/core';
import {PLUGIN_OPTIONS, Plugin} from '@motion-canvas/vite-plugin';
import {SingleBar} from 'cli-progress';
import ffmpeg from 'fluent-ffmpeg';
import * as fs from 'fs';
import kleur from 'kleur';
import * as path from 'path';
import {PassThrough} from 'stream';

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

declare global {
  interface Window {
    handleLog(payload: LogPayload): void;
    handleRenderStart(): void;
    handleRenderEnd(result: string): void;
    handleRender(frame: number, duration: number): void;
  }
}

interface Config {
  output?: string;
  project?: string;
  debug?: boolean;
  product: 'chrome' | 'firefox';
}

export async function render(
  config: Config,
  settings: Partial<RendererSettings> = {},
) {
  // Keep stdin in raw mode to handle Ctrl+C
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    // Handle Ctrl+C in raw mode
    process.stdin.on('data', (key: Buffer | string) => {
      const keyStr = Buffer.isBuffer(key) ? key.toString() : key;
      if (keyStr === '\u0003') {
        console.log('\nReceived Ctrl+C, cleaning up...');
        cleanup();
      }
    });
  }

  const spinner = (await import('ora'))
    .default('Launching headless browser...\n')
    .start();

  const {createServer} = await import('vite');
  const puppeteer = await import('puppeteer');

  let browser: any;
  let server: any;
  let ffmpegStream: PassThrough | null = null;
  let ffmpegCommand: ffmpeg.FfmpegCommand | null = null;
  let isCleaningUp = false;

  // Handle process termination
  const cleanup = async () => {
    if (isCleaningUp) return;
    isCleaningUp = true;
    console.log('\nCleaning up...');

    try {
      if (ffmpegCommand) {
        ffmpegCommand.kill('SIGKILL');
      }
      if (ffmpegStream) {
        ffmpegStream.end();
      }
      if (browser) await browser.close();
      if (server) await server.close();
      process.exit(0);
    } catch (error) {
      console.error('Error during cleanup:', error);
      process.exit(1);
    }
  };

  // Handle various termination signals
  ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'].forEach(signal => {
    process.on(signal, cleanup);
  });

  process.on('uncaughtException', (error: Error) => {
    console.error('Uncaught exception:', error);
    cleanup();
  });

  try {
    spinner.text = 'starting puppeteer, and vite server...\n';
    [browser, server] = await Promise.all([
      puppeteer.launch({
        product: 'chrome',
        headless: !config.debug,
        protocol: 'cdp',
        args: ['--no-sandbox'],
      }),
      createServer({
        plugins: [
          {
            name: 'renderer-plugin',
            [PLUGIN_OPTIONS]: {
              async config() {
                if (config.output) {
                  return {output: config.output};
                }
              },
            },
          } as Plugin,
        ],
      }).then(server => server.listen()),
    ]);

    spinner.text = 'starting browser page...\n';
    const page = await browser.newPage();

    const resultPromise = new Promise<string>((resolve, reject) => {
      page.on('pageerror', ({message}: {message: string}) => reject(message));
      page.exposeFunction('handleRenderEnd', (result: string) => {
        resolve(result);
      });
    });

    // Initialize FFmpeg if specified
    if (settings.exporter?.name === '@motion-canvas/ffmpeg') {
      console.log('Setting up FFmpeg exporter...');
      const outputDir = config.output || process.cwd();
      if (!fs.existsSync(outputDir)) {
        spinner.text = 'creating output directory...\n';
        await fs.promises.mkdir(outputDir, {recursive: true});
      }

      console.log('Initializing FFmpeg stream...');
      ffmpegStream = new PassThrough();
      ffmpegCommand = ffmpeg();

      // Add error handler for FFmpeg
      ffmpegCommand.on('error', err => {
        console.error('FFmpeg error:', err);
        cleanup();
      });

      console.log('Configuring FFmpeg input...');
      // Input image sequence
      ffmpegCommand
        .input(ffmpegStream)
        .inputFormat('image2pipe')
        .inputFps(settings.fps ?? 30)
        .inputOptions(['-f image2pipe', '-i -']);

      // Input audio file if specified
      const options =
        (settings.exporter.options as {
          includeAudio?: boolean;
          fastStart?: boolean;
        }) ?? {};
      if (options.includeAudio && (settings as any).audio) {
        console.log('Adding audio input to FFmpeg...');
        ffmpegCommand
          .input((settings as any).audio)
          .inputOptions([`-itsoffset ${(settings as any).audioOffset ?? 0}`]);
      }

      console.log('Configuring FFmpeg output...');
      // Output settings
      const size = {
        x: Math.round(
          (settings.size?.x ?? 1920) * (settings.resolutionScale ?? 1),
        ),
        y: Math.round(
          (settings.size?.y ?? 1080) * (settings.resolutionScale ?? 1),
        ),
      };
      ffmpegCommand
        .output(path.join(outputDir, `${settings.name ?? 'output'}.mp4`))
        .outputOptions([
          '-pix_fmt yuv420p',
          '-shortest',
          '-c:v libx264',
          '-preset medium',
          '-crf 23',
        ])
        .outputFps(settings.fps ?? 30)
        .size(`${size.x}x${size.y}`);

      if (options.fastStart) {
        console.log('Enabling fast start for MP4...');
        ffmpegCommand.outputOptions(['-movflags +faststart']);
      }

      // Add progress handler
      ffmpegCommand.on('progress', progress => {
        console.log(`FFmpeg progress: ${progress.percent?.toFixed(2)}%`);
      });

      // Add end handler
      ffmpegCommand.on('end', () => {
        console.log('FFmpeg process completed');
      });

      console.log('Starting FFmpeg process...');
      ffmpegCommand.run();
      console.log('FFmpeg process started');
    }

    const bar = new SingleBar({
      format:
        'Rendering {bar} {percentage}% | ETA: {eta}s | Frame {value}/{total}',
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
    });

    // Handle frames for FFmpeg
    if (ffmpegStream) {
      console.log('Setting up frame capture for FFmpeg...');
      page.on(
        'console',
        async (msg: {type: () => string; text: () => string}) => {
          if (msg.type() === 'log' && msg.text().startsWith('frame:')) {
            const canvas = await page.evaluate(() => {
              const canvas = document.querySelector('canvas');
              if (!canvas) return null;
              const ctx = canvas.getContext('2d');
              if (!ctx) return null;
              return canvas.toDataURL('image/png');
            });
            if (canvas) {
              const base64Data = canvas.slice(canvas.indexOf(',') + 1);
              const buffer = Buffer.from(base64Data, 'base64');
              ffmpegStream!.write(buffer);
            }
          }
        },
      );

      // Listen for the render event to capture frames
      await page.exposeFunction(
        'handleRender',
        async (frame: number, total: number) => {
          bar.setTotal(total);
          bar.update(frame);

          // Capture frame for FFmpeg
          if (ffmpegStream) {
            const canvas = await page.evaluate(() => {
              const canvas = document.querySelector('canvas');
              if (!canvas) return null;
              const ctx = canvas.getContext('2d');
              if (!ctx) return null;
              return canvas.toDataURL('image/png');
            });
            if (canvas) {
              const base64Data = canvas.slice(canvas.indexOf(',') + 1);
              const buffer = Buffer.from(base64Data, 'base64');
              ffmpegStream.write(buffer);
            }
          }
        },
      );
      console.log('Frame capture setup complete');
    } else {
      await page.exposeFunction(
        'handleRender',
        async (frame: number, total: number) => {
          bar.setTotal(total);
          bar.update(frame);
        },
      );
    }

    const payloads: LogPayload[] = [];
    await page.exposeFunction('handleLog', (payload: LogPayload) => {
      payloads.push(payload);
    });

    await page.exposeFunction('handleRenderStart', () => {
      spinner.stop();
      bar.start(1, 0);
    });

    await page.evaluateOnNewDocument(() => {
      window.addEventListener('render', ((event: Event) => {
        const customEvent = event as CustomEvent;
        window.handleRender(customEvent.detail.frame, customEvent.detail.total);
      }) as EventListener);
      window.addEventListener('renderend', ((event: CustomEvent) => {
        window.handleRenderEnd(event.detail);
      }) as EventListener);
      window.addEventListener('renderstart', (() => {
        window.handleRenderStart();
      }) as EventListener);
      window.addEventListener('log', ((event: CustomEvent) => {
        window.handleLog(event.detail);
      }) as EventListener);
    });

    const url = new URL(`http://localhost`);
    url.port = server.config.server.port!.toString();
    url.searchParams.set('headless', JSON.stringify(settings));
    if (config.project) {
      url.pathname = config.project;
    }

    spinner.text = `Loading project...\n`;
    console.log('Attempting to load URL:', url.toString());
    try {
      await page.goto(url.toString(), {
        waitUntil: 'networkidle0',
        timeout: 60000 * 60,
      });
      console.log('Page loaded successfully');
    } catch (error) {
      console.error('Failed to load page:', error);
      throw error;
    }

    const result = await resultPromise;
    bar.stop();

    for (const payload of payloads) {
      printLog(payload);
    }

    switch (result) {
      case 'success':
        console.log(kleur.green('√ Rendering complete.'));
        break;
      case 'aborted':
        console.log(kleur.yellow('! Rendering aborted.'));
        break;
      case 'error':
        console.log(kleur.red('× Rendering failed.'));
        break;
    }
  } catch (error) {
    console.error('Error during rendering:', error);
    await cleanup();
    throw error;
  }
}

function printLog(payload: LogPayload) {
  const level = payload.level ?? 'unknown';
  switch (level) {
    case 'error':
      console.log(kleur.red(`[${level.toUpperCase()}] ${payload.message}`));
      break;
    case 'warn':
      console.log(kleur.yellow(`[${level.toUpperCase()}] ${payload.message}`));
      break;
    default:
      console.log(`[${level.toUpperCase()}] ${payload.message}`);
      break;
  }

  if (payload.stack) {
    console.log(kleur.bold('Stack trace:'));
    console.log(payload.stack);
  }
}
