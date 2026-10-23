import { defineConfig } from 'vite';
import monkey from 'vite-plugin-monkey';
import pkg from './package.json';

// 单一版本来源：package.json。
// 构建时通过 define 注入到运行时，同时写入 userscript 头部。
const version = pkg.version;

// https://vitejs.dev/config/
export default defineConfig({
  define: {
    __DSCE_VERSION__: JSON.stringify(version),
  },
  plugins: [
    monkey({
      entry: 'src/main.ts',
      userscript: {
        name: 'DeepSeek Chat Enhance',
        namespace: 'ds-chat-enhance',
        version,
        description: 'Enhancements for chat.deepseek.com',
        icon: 'https://chat.deepseek.com/favicon.ico',
        match: ['https://chat.deepseek.com/*'],
        'run-at': 'document-end',
      },
    }),
  ],
});
