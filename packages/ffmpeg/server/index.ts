import {Plugin, PLUGIN_OPTIONS, PluginConfig} from '@motion-canvas/vite-plugin';
import {FFmpegBridge} from './FFmpegBridge';

export default (): Plugin => {
  let config: PluginConfig;
  return {
    name: 'motion-canvas/ffmpeg',
    [PLUGIN_OPTIONS]: {
      entryPoint: '@motion-canvas/ffmpeg/lib/client',
      async configResolved(value) {
        config = value;
      },
    },
    configureServer(server) {
      new FFmpegBridge(server, config);
    },
  };
};
